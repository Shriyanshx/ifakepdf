"use client";

/**
 * EditPanel
 * ─────────
 * Two-step AI generation panel:
 *  1. User clicks "Generate Preview" → AI generates PNG → overlay shown on PDF
 *  2. User drags overlay to adjust position, then clicks "Confirm & Apply"
 *     → image inserted into PDF at the (possibly adjusted) bbox.
 */

import { useState, useRef } from "react";
import {
  Wand2,
  Image as ImageIcon,
  X,
  RotateCcw,
  CheckCircle,
  SlidersHorizontal,
  ChevronDown,
  ChevronUp,
  Download,
  PenLine,
} from "lucide-react";
import type { BBox } from "./PDFViewer";
import { generateImage, insertImage } from "@/lib/api";

type GenerationType = "signature" | "handwriting" | "custom";

type Status = "idle" | "generating" | "preview" | "inserting" | "done" | "error";

interface EditPanelProps {
  pdfFile: File | null;
  pageIndex: number;
  /** The user-drawn bbox (PDF user-space coords, origin=bottom-left). */
  bbox: BBox | null;
  /** The (possibly drag-adjusted) bbox passed back from PDFViewer. */
  adjustedBBox: BBox | null;
  onResultReady: (blob: Blob) => void;
  onReset: () => void;
  /** Called when a preview image is ready — parent stores it and passes to PDFViewer. */
  onPreviewReady: (imageBlob: Blob, bbox: BBox) => void;
  /** Called when preview is cancelled or regeneration is requested. */
  onCancelPreview: () => void;
  /** URL to current result PDF for in-panel download (set after first edit). */
  resultURL?: string | null;
  onDownload?: () => void;
}

const GEN_TYPES: { value: GenerationType; label: string; desc: string }[] = [
  { value: "signature", label: "Signature", desc: "Cursive handwritten signature" },
  { value: "handwriting", label: "Handwriting", desc: "Printed / cursive text" },
  { value: "custom", label: "Custom", desc: "Fully custom prompt" },
];

const PROMPT_PRESETS: Record<GenerationType, string> = {
  signature: "",
  handwriting: "",
  custom: "",
};

export default function EditPanel({
  pdfFile,
  pageIndex,
  bbox,
  adjustedBBox,
  onResultReady,
  onReset,
  onPreviewReady,
  onCancelPreview,
  resultURL,
  onDownload,
}: EditPanelProps) {
  const [genType, setGenType] = useState<GenerationType>("signature");
  const [prompt, setPrompt] = useState(PROMPT_PRESETS.signature);
  const [refImage, setRefImage] = useState<File | null>(null);
  const [refPreview, setRefPreview] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [previewThumbURL, setPreviewThumbURL] = useState<string | null>(null);
  const refImageInputRef = useRef<HTMLInputElement>(null);

  // ── Blending controls ───────────────────────────────────────────────────
  const [showBlending, setShowBlending] = useState(false);
  const [featherRadius, setFeatherRadius] = useState(4);
  const [noiseAmount, setNoiseAmount] = useState(0.012);
  const [edgeExpand, setEdgeExpand] = useState(15);

  // ── Handlers ────────────────────────────────────────────────────────────
  const handleTypeChange = (t: GenerationType) => {
    setGenType(t);
    setPrompt(PROMPT_PRESETS[t]);
  };

  const handleRefImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setRefImage(f);
    const url = URL.createObjectURL(f);
    setRefPreview(url);
  };

  const clearRefImage = () => {
    setRefImage(null);
    setRefPreview(null);
    if (refImageInputRef.current) refImageInputRef.current.value = "";
  };

  // Step 1: generate preview image only (no PDF modification)
  const handleGeneratePreview = async () => {
    if (!pdfFile || !bbox) return;
    setStatus("generating");
    setErrorMsg("");
    try {
      const blob = await generateImage({
        pdf: pdfFile,
        page: pageIndex,
        bbox,
        prompt,
        generationType: genType,
        referenceImage: refImage,
      });
      const thumbURL = URL.createObjectURL(blob);
      setPreviewBlob(blob);
      setPreviewThumbURL(thumbURL);
      setStatus("preview");
      onPreviewReady(blob, bbox);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  };

  // Step 2: insert the preview image into the PDF at the (possibly adjusted) bbox
  const handleConfirmInsert = async () => {
    if (!pdfFile || !previewBlob || !adjustedBBox) return;
    setStatus("inserting");
    setErrorMsg("");
    try {
      const resultBlob = await insertImage({
        pdf: pdfFile,
        page: pageIndex,
        bbox: adjustedBBox,
        image: previewBlob,
        featherRadius,
        noiseAmount,
        edgeExpand,
      });
      onResultReady(resultBlob);
      setStatus("done");
      if (previewThumbURL) URL.revokeObjectURL(previewThumbURL);
      setPreviewBlob(null);
      setPreviewThumbURL(null);
      onCancelPreview();
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  };

  const handleRegenerate = () => {
    if (previewThumbURL) URL.revokeObjectURL(previewThumbURL);
    setPreviewBlob(null);
    setPreviewThumbURL(null);
    setStatus("idle");
    onCancelPreview();
  };

  const handleCancel = () => {
    if (previewThumbURL) URL.revokeObjectURL(previewThumbURL);
    setPreviewBlob(null);
    setPreviewThumbURL(null);
    setStatus("idle");
    onCancelPreview();
  };

  // Reset panel to idle for another edit (pdfFile already updated to modified PDF)
  const handleEditAgain = () => {
    setStatus("idle");
    setErrorMsg("");
  };

  const canGenerate = !!pdfFile && !!bbox && (status === "idle" || status === "error");
  const inPreview = status === "preview";
  const isWorking = status === "generating" || status === "inserting";
  const isDone = status === "done";

  // ── Bbox info chip ──────────────────────────────────────────────────────
  const bboxChip = bbox ? (
    <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-3 py-2 text-xs text-emerald-400 font-mono">
      <span className="font-semibold text-emerald-300">Region selected</span>
      <span className="text-slate-400">
        {Math.round(bbox.width)}×{Math.round(bbox.height)} pt
      </span>
    </div>
  ) : (
    <div className="flex items-center gap-2 rounded-lg bg-slate-800/50 border border-[#2e3348] px-3 py-2 text-xs text-slate-500">
      No region selected — drag on the PDF
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      {/* -----------------------------------------------------------------
          Scrollable content area — form controls live here
      ------------------------------------------------------------------ */}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-5 px-5 pt-6 pb-4">
        {/* ── Header ── */}
        <div>
          <h2 className="text-base font-semibold text-slate-100">Edit Region</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Configure what the AI should generate inside the selected area.
          </p>
        </div>

      {/* ── Selected region indicator ── */}
      {bboxChip}

      {/* ── Generation Type ── */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
          Type
        </label>
        <div className="grid grid-cols-2 gap-2">
          {GEN_TYPES.map((t) => (
            <button
              key={t.value}
              onClick={() => handleTypeChange(t.value)}
              className={`rounded-lg border px-3 py-2 text-left transition-all ${
                genType === t.value
                  ? "border-indigo-500 bg-indigo-500/10 text-indigo-300"
                  : "border-[#2e3348] bg-[#222636] text-slate-400 hover:border-indigo-500/40"
              }`}
            >
              <div className="text-sm font-medium">{t.label}</div>
              <div className="text-[10px] text-slate-500 mt-0.5 leading-tight">
                {t.desc}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ── Prompt ── */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
          Prompt
        </label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder="Describe what should be generated…"
          className="w-full rounded-lg border border-[#2e3348] bg-[#222636] px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 resize-none transition-all"
        />
      </div>

      {/* ── Reference Image ── */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
          Reference Image <span className="text-slate-600">(optional)</span>
        </label>
        {refPreview ? (
          <div className="relative group rounded-lg overflow-hidden border border-[#2e3348]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={refPreview}
              alt="Reference"
              className="w-full h-28 object-contain bg-[#222636]"
            />
            <button
              onClick={clearRefImage}
              className="absolute top-2 right-2 rounded-full bg-red-600/80 p-1 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <X size={12} />
            </button>
          </div>
        ) : (
          <button
            onClick={() => refImageInputRef.current?.click()}
            className="w-full rounded-lg border border-dashed border-[#2e3348] hover:border-indigo-500/50 bg-[#222636] px-3 py-3 text-sm text-slate-500 hover:text-slate-300 flex items-center justify-center gap-2 transition-all"
          >
            <ImageIcon size={14} />
            Upload reference image
          </button>
        )}
        <input
          ref={refImageInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleRefImageChange}
        />
      </div>

        {/* ── Blending Controls (collapsible) ── */}
        <div className="space-y-2">
          <button
            onClick={() => setShowBlending((v) => !v)}
            className="flex items-center justify-between w-full text-xs font-medium text-slate-400 uppercase tracking-wider hover:text-slate-300 transition-colors"
          >
            <span className="flex items-center gap-1.5">
              <SlidersHorizontal size={12} />
              Blending Controls
            </span>
            {showBlending ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>

          {showBlending && (
            <div className="space-y-3 rounded-lg border border-[#2e3348] bg-[#222636] p-3">
              {/* Feather Radius */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] text-slate-400">Edge Feather</label>
                  <span className="text-[11px] text-slate-500 font-mono">
                    {featherRadius}px
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={15}
                  step={1}
                  value={featherRadius}
                  onChange={(e) => setFeatherRadius(Number(e.target.value))}
                  className="w-full accent-indigo-500 h-1.5 rounded-full appearance-none bg-slate-700 cursor-pointer"
                />
                <div className="flex justify-between text-[9px] text-slate-600">
                  <span>Hard</span>
                  <span>Soft</span>
                </div>
              </div>

              {/* Noise Amount */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] text-slate-400">Grain / Noise</label>
                  <span className="text-[11px] text-slate-500 font-mono">
                    {(noiseAmount * 100).toFixed(1)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={0.05}
                  step={0.002}
                  value={noiseAmount}
                  onChange={(e) => setNoiseAmount(Number(e.target.value))}
                  className="w-full accent-indigo-500 h-1.5 rounded-full appearance-none bg-slate-700 cursor-pointer"
                />
                <div className="flex justify-between text-[9px] text-slate-600">
                  <span>None</span>
                  <span>Heavy</span>
                </div>
              </div>

              {/* Edge Expand */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] text-slate-400">Edge Expand</label>
                  <span className="text-[11px] text-slate-500 font-mono">
                    {edgeExpand}pt
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={30}
                  step={1}
                  value={edgeExpand}
                  onChange={(e) => setEdgeExpand(Number(e.target.value))}
                  className="w-full accent-indigo-500 h-1.5 rounded-full appearance-none bg-slate-700 cursor-pointer"
                />
                <div className="flex justify-between text-[9px] text-slate-600">
                  <span>None</span>
                  <span>Wide</span>
                </div>
              </div>

              {/* Reset to defaults */}
              <button
                onClick={() => {
                  setFeatherRadius(4);
                  setNoiseAmount(0.012);
                  setEdgeExpand(15);
                }}
                className="w-full text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                Reset to defaults
              </button>
            </div>
          )}
        </div>
      </div>{/* end scrollable area */}

      {/* -----------------------------------------------------------------
          Pinned bottom section — always visible, never scrolled away
      ------------------------------------------------------------------ */}
      <div className="shrink-0 flex flex-col gap-3 px-5 pt-4 pb-5 border-t border-[#1f2335]">

      {/* ── Preview thumbnail (shown in preview / inserting state) ── */}
      {(inPreview || status === "inserting") && previewThumbURL && (
        <div className="space-y-2">
          <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
            Preview
          </label>
          <div className="rounded-lg overflow-hidden border border-indigo-500/40 bg-[#222636]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewThumbURL}
              alt="Generated preview"
              className="w-full object-contain max-h-32"
            />
          </div>
          <p className="text-[10px] text-slate-500">
            Drag the overlay on the PDF to reposition, then confirm.
          </p>
        </div>
      )}

      {/* ── Error ── */}
      {status === "error" && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2 text-xs text-red-400">
          {errorMsg}
        </div>
      )}

      {/* ── Success screen ── */}
      {isDone && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-3 py-3">
            <CheckCircle size={16} className="text-emerald-400 shrink-0" />
            <div>
              <p className="text-xs font-semibold text-emerald-300">Edit applied!</p>
              <p className="text-[11px] text-slate-400 mt-0.5">
                The PDF has been updated. Select a new region to keep editing.
              </p>
            </div>
          </div>

          {/* Edit another region on the modified PDF */}
          <button
            onClick={handleEditAgain}
            className="w-full flex items-center justify-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-3 text-sm transition-all shadow-lg"
          >
            <PenLine size={15} />
            Edit Another Region
          </button>

          {/* Download the modified PDF */}
          {onDownload && resultURL && (
            <button
              onClick={onDownload}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-3 text-sm transition-all shadow-lg"
            >
              <Download size={15} />
              Download PDF
            </button>
          )}

          {/* Load a completely new file */}
          <button
            onClick={onReset}
            className="w-full flex items-center justify-center gap-2 rounded-xl border border-[#2e3348] hover:bg-[#2e3348] text-slate-400 py-2.5 text-sm transition-all"
          >
            <RotateCcw size={14} />
            New File
          </button>
        </div>
      )}

      {/* ── Normal actions (idle / generating / preview) ── */}
      {!isDone && (
        <div className="space-y-2">
          {/* Step 1: Generate Preview */}
          {!inPreview && (
            <button
              onClick={handleGeneratePreview}
              disabled={!canGenerate || isWorking}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-3 text-sm transition-all shadow-lg"
            >
              {status === "generating" ? (
                <>
                  <div className="spinner" />
                  Generating…
                </>
              ) : (
                <>
                  <Wand2 size={16} />
                  Generate Preview
                </>
              )}
            </button>
          )}

          {/* Step 2: Confirm & Apply (only in preview / inserting state) */}
          {(inPreview || status === "inserting") && (
            <>
              <button
                onClick={handleConfirmInsert}
                disabled={!adjustedBBox || isWorking}
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-3 text-sm transition-all shadow-lg"
              >
                {isWorking ? (
                  <>
                    <div className="spinner" />
                    Applying…
                  </>
                ) : (
                  <>
                    <CheckCircle size={16} />
                    Confirm &amp; Apply
                  </>
                )}
              </button>
              <button
                onClick={handleRegenerate}
                disabled={isWorking}
                className="w-full flex items-center justify-center gap-2 rounded-xl border border-indigo-500/40 hover:bg-indigo-500/10 text-indigo-400 py-2.5 text-sm transition-all"
              >
                <Wand2 size={14} />
                Regenerate
              </button>
              <button
                onClick={handleCancel}
                disabled={isWorking}
                className="w-full flex items-center justify-center gap-2 rounded-xl border border-[#2e3348] hover:bg-[#2e3348] text-slate-400 py-2.5 text-sm transition-all"
              >
                <X size={14} />
                Cancel
              </button>
            </>
          )}

          {/* Reset / new file */}
          {!inPreview && !isWorking && (
            <button
              onClick={onReset}
              className="w-full flex items-center justify-center gap-2 rounded-xl border border-[#2e3348] hover:bg-[#2e3348] text-slate-400 py-2.5 text-sm transition-all"
            >
              <RotateCcw size={14} />
              New File
            </button>
          )}
        </div>
      )}
      </div>{/* end pinned bottom */}
    </div>
  );
}
