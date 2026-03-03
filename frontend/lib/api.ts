/**
 * API client for the ifakepdf Python backend.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// ── Rate-limit error ──────────────────────────────────────────────────────────
export class RateLimitError extends Error {
  remaining: number;
  resetInSeconds: number;
  constructor(message: string, remaining = 0, resetInSeconds = 0) {
    super(message);
    this.name = "RateLimitError";
    this.remaining = remaining;
    this.resetInSeconds = resetInSeconds;
  }
}

/** Throws RateLimitError on 429, generic Error otherwise. */
async function throwIfNotOk(res: Response, tag: string): Promise<void> {
  if (res.ok) return;
  if (res.status === 429) {
    let detail: { message?: string; remaining?: number; reset_in_seconds?: number } = {};
    try {
      const body = await res.json();
      detail = body.detail ?? body;
    } catch {}
    throw new RateLimitError(
      detail.message ?? "Rate limit exceeded. Try again later.",
      detail.remaining ?? 0,
      detail.reset_in_seconds ?? 0,
    );
  }
  const msg = await res.text().catch(() => res.statusText);
  throw new Error(`${tag} error ${res.status}: ${msg}`);
}

// ── Rate-limit status ─────────────────────────────────────────────────────────
export interface RateLimitStatus {
  remaining: number;
  limit: number;
  window_seconds: number;
  reset_in_seconds: number;
}

export async function getRateLimitStatus(): Promise<RateLimitStatus> {
  const res = await fetch(`${API_BASE}/api/rate-limit-status`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to fetch rate-limit status: ${res.status}`);
  return res.json();
}

export interface BBoxPayload {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type GenerationType =
  | "signature"
  | "handwriting"
  | "seal"
  | "stamp"
  | "custom";

// ── Step 1: Generate image (returns PNG blob, no PDF modification) ──────────
export interface GenerateImageOptions {
  pdf: File;
  page: number;
  bbox: BBoxPayload;
  prompt?: string;
  generationType: GenerationType;
  referenceImage?: File | null;
  /** OpenAI model to use (e.g. "gpt-image-1", "gpt-image-1-mini", "dall-e-2") */
  aiModel?: string;
  /** When true, use the OpenAI image-edit API with the region as source */
  useEditApi?: boolean;
  /** Quality for GPT image edit: "auto" | "low" | "medium" | "high" */
  editQuality?: string;
}

export async function generateImage(opts: GenerateImageOptions): Promise<Blob> {
  const form = new FormData();
  form.append("pdf", opts.pdf);
  form.append("page", String(opts.page));
  form.append("x", String(opts.bbox.x));
  form.append("y", String(opts.bbox.y));
  form.append("width", String(opts.bbox.width));
  form.append("height", String(opts.bbox.height));
  form.append("prompt", opts.prompt ?? "");
  form.append("generation_type", opts.generationType);
  if (opts.referenceImage) form.append("reference_image", opts.referenceImage);
  if (opts.aiModel) form.append("ai_model", opts.aiModel);
  if (opts.useEditApi) form.append("use_edit", "true");
  if (opts.editQuality) form.append("edit_quality", opts.editQuality);

  const res = await fetch(`${API_BASE}/api/generate-image`, {
    method: "POST",
    credentials: "include",
    body: form,
  });
  await throwIfNotOk(res, "Backend");
  return res.blob();
}

// ── Step 2: Insert a pre-generated image at (adjusted) position ─────────────
export interface InsertImageOptions {
  pdf: File;
  page: number;
  bbox: BBoxPayload;
  image: Blob;
  /** Edge feather radius in px (0 = hard edges, 1–10 = soft). Default: 4 */
  featherRadius?: number;
  /** Gaussian noise σ as fraction of 255 (0 = none). Default: 0.012 */
  noiseAmount?: number;
  /** Expansion padding in PDF pts for edge blending. Default: 15 */
  edgeExpand?: number;
}

export async function insertImage(opts: InsertImageOptions): Promise<Blob> {
  const form = new FormData();
  form.append("pdf", opts.pdf);
  form.append("page", String(opts.page));
  form.append("x", String(opts.bbox.x));
  form.append("y", String(opts.bbox.y));
  form.append("width", String(opts.bbox.width));
  form.append("height", String(opts.bbox.height));
  form.append("image", opts.image, "generated.png");
  if (opts.featherRadius !== undefined)
    form.append("feather_radius", String(opts.featherRadius));
  if (opts.noiseAmount !== undefined)
    form.append("noise_amount", String(opts.noiseAmount));
  if (opts.edgeExpand !== undefined)
    form.append("edge_expand", String(opts.edgeExpand));

  const res = await fetch(`${API_BASE}/api/insert-image`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Backend error ${res.status}: ${msg}`);
  }
  return res.blob();
}

// ── Legacy single-step (kept for reference) ─────────────────────────────────

// ── Redact Region ──────────────────────────────────────────────────────────
export interface RedactRegionOptions {
  pdf: File;
  page: number;
  bbox: BBoxPayload;
  color?: string;
}

export async function redactRegion(opts: RedactRegionOptions): Promise<Blob> {
  const form = new FormData();
  form.append("pdf", opts.pdf);
  form.append("page", String(opts.page));
  form.append("x", String(opts.bbox.x));
  form.append("y", String(opts.bbox.y));
  form.append("width", String(opts.bbox.width));
  form.append("height", String(opts.bbox.height));
  if (opts.color) form.append("color", opts.color);

  const res = await fetch(`${API_BASE}/api/redact-region`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Backend error ${res.status}: ${msg}`);
  }
  return res.blob();
}

// ── Whiten Region ──────────────────────────────────────────────────────────
export interface WhitenRegionOptions {
  pdf: File;
  page: number;
  bbox: BBoxPayload;
}

export async function whitenRegion(opts: WhitenRegionOptions): Promise<Blob> {
  const form = new FormData();
  form.append("pdf", opts.pdf);
  form.append("page", String(opts.page));
  form.append("x", String(opts.bbox.x));
  form.append("y", String(opts.bbox.y));
  form.append("width", String(opts.bbox.width));
  form.append("height", String(opts.bbox.height));

  const res = await fetch(`${API_BASE}/api/whiten-region`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Backend error ${res.status}: ${msg}`);
  }
  return res.blob();
}

// ── Add Text ───────────────────────────────────────────────────────────────
export interface AddTextOptions {
  pdf: File;
  page: number;
  bbox: BBoxPayload;
  text: string;
  fontSize?: number;
  fontColor?: string;
  fontFamily?: string;
  align?: number;
}

export async function addText(opts: AddTextOptions): Promise<Blob> {
  const form = new FormData();
  form.append("pdf", opts.pdf);
  form.append("page", String(opts.page));
  form.append("x", String(opts.bbox.x));
  form.append("y", String(opts.bbox.y));
  form.append("width", String(opts.bbox.width));
  form.append("height", String(opts.bbox.height));
  form.append("text", opts.text);
  if (opts.fontSize !== undefined) form.append("font_size", String(opts.fontSize));
  if (opts.fontColor) form.append("font_color", opts.fontColor);
  if (opts.fontFamily) form.append("font_family", opts.fontFamily);
  if (opts.align !== undefined) form.append("align", String(opts.align));

  const res = await fetch(`${API_BASE}/api/add-text`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Backend error ${res.status}: ${msg}`);
  }
  return res.blob();
}
export interface ProcessOptions {
  pdf: File;
  page: number;
  bbox: BBoxPayload;
  prompt?: string;
  generationType: GenerationType;
  referenceImage?: File | null;
}

export async function processPDF(opts: ProcessOptions): Promise<Blob> {
  const form = new FormData();
  form.append("pdf", opts.pdf);
  form.append("page", String(opts.page));
  form.append("x", String(opts.bbox.x));
  form.append("y", String(opts.bbox.y));
  form.append("width", String(opts.bbox.width));
  form.append("height", String(opts.bbox.height));
  form.append("prompt", opts.prompt ?? "");
  form.append("generation_type", opts.generationType);
  if (opts.referenceImage) form.append("reference_image", opts.referenceImage);

  const res = await fetch(`${API_BASE}/api/process`, {
    method: "POST",
    credentials: "include",
    body: form,
  });
  await throwIfNotOk(res, "Backend");
  return res.blob();
}

export async function previewRegion(
  pdf: File,
  page: number,
  bbox: BBoxPayload
): Promise<Blob> {
  const form = new FormData();
  form.append("pdf", pdf);
  form.append("page", String(page));
  form.append("x", String(bbox.x));
  form.append("y", String(bbox.y));
  form.append("width", String(bbox.width));
  form.append("height", String(bbox.height));

  const res = await fetch(`${API_BASE}/api/preview-region`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`Preview error ${res.status}`);
  return res.blob();
}
