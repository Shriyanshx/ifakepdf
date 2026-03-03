/**
 * API client for the ifakepdf Python backend.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

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

  const res = await fetch(`${API_BASE}/api/generate-image`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Backend error ${res.status}: ${msg}`);
  }
  return res.blob();
}

// ── Step 2: Insert a pre-generated image at (adjusted) position ─────────────
export interface InsertImageOptions {
  pdf: File;
  page: number;
  bbox: BBoxPayload;
  image: Blob;
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
    body: form,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Backend error ${res.status}: ${msg}`);
  }
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
