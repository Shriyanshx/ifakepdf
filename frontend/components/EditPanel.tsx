"use client";

/**
 * EditPanel
 * ─────────
 * Tool-aware side panel that shows different options depending on the
 * active tool mode selected in the top toolbar.
 *
 * Tools:
 *  - select    → AI generation (handwriting / custom)
 *  - redact    → Black-fill selected region
 *  - whiten    → White-fill selected region
 *  - addimage  → Pick local image, drag to position, insert
 *  - text      → Insert text in selected region
 */

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Wand2,
  Image as ImageIcon,
  X,
  RotateCcw,
  CheckCircle,
  SlidersHorizontal,
  ChevronDown,
  ChevronUp,
  EyeOff,
  Eraser,
  Type,
  ImagePlus,
  Download,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
} from "lucide-react";
import type { BBox } from "./PDFViewer";
import { generateImage, insertImage, addText, redactRegion, whitenRegion } from "@/lib/api";

type GenerationType = "signature" | "handwriting" | "custom";
type ToolMode = "select" | "redact" | "whiten" | "addimage" | "text";
type Status = "idle" | "generating" | "preview" | "inserting" | "done" | "error";

interface EditPanelProps {
  pdfFile: File | null;
  pageIndex: number;
  toolMode: ToolMode;
  bbox: BBox | null;
  adjustedBBox: BBox | null;
  onResultReady: (blob: Blob) => void;
  onReset: () => void;
  onPreviewReady: (imageBlob: Blob, bbox: BBox) => void;
  onCancelPreview: () => void;
  resultURL?: string | null;
  onDownload?: () => void;
  onUndo?: () => void;
  canUndo?: boolean;
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

const TOOL_INFO: Record<ToolMode, { title: string; desc: string }> = {
  select:    { title: "Edit Region",   desc: "AI-generate content inside the selected area." },
  redact:    { title: "Redact",        desc: "Black out the selected region to hide content." },
  whiten:    { title: "Whiten",        desc: "White out the selected region to erase content." },
  addimage:  { title: "Add Image",     desc: "Pick a local image and place it on the page." },
  text:      { title: "Add Text",      desc: "Insert typed text within the selected region." },
};

const FONT_FAMILIES = [
  { value: "helv",  label: "Helvetica" },
  { value: "tiro",  label: "Times Roman" },
  { value: "cour",  label: "Courier" },
];

const FONT_SIZES = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48];

const COLOR_PRESETS = [
  { value: "#000000", label: "Black" },
  { value: "#FF0000", label: "Red" },
  { value: "#0000FF", label: "Blue" },
  { value: "#006400", label: "Green" },
  { value: "#8B4513", label: "Brown" },
  { value: "#4B0082", label: "Indigo" },
];

const REDACT_COLOR_PRESETS = [
  { value: "#000000", label: "Black" },
  { value: "#333333", label: "Dark Gray" },
  { value: "#FF0000", label: "Red" },
  { value: "#0000FF", label: "Blue" },
  { value: "#006400", label: "Green" },
];

const ALIGN_OPTIONS = [
  { value: 0, icon: AlignLeft,    label: "Left" },
  { value: 1, icon: AlignCenter,  label: "Center" },
  { value: 2, icon: AlignRight,   label: "Right" },
  { value: 3, icon: AlignJustify, label: "Justify" },
];

export default function EditPanel({
  pdfFile,
  pageIndex,
  toolMode,
  bbox,
  adjustedBBox,
  onResultReady,
  onReset,
  onPreviewReady,
  onCancelPreview,
  resultURL,
  onDownload,
  onUndo,
  canUndo = false,
}: EditPanelProps) {
  // ── AI generation state ─────────────────────────────────────────────────
  const [genType, setGenType] = useState<GenerationType>("custom");
  const [prompt, setPrompt] = useState(PROMPT_PRESETS.custom);
  const [refImage, setRefImage] = useState<File | null>(null);
  const [refPreview, setRefPreview] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [previewThumbURL, setPreviewThumbURL] = useState<string | null>(null);
  const refImageInputRef = useRef<HTMLInputElement>(null);

  // ── AI model & edit-mode state ──────────────────────────────────────────
  const [aiModel, setAiModel] = useState("gemini-3.1-flash-image-preview");
  const [useEditApi, setUseEditApi] = useState(false);
  const [editQuality, setEditQuality] = useState("auto");

  // ── Blending controls ───────────────────────────────────────────────────
  const [showBlending, setShowBlending] = useState(false);
  const [featherRadius, setFeatherRadius] = useState(4);
  const [noiseAmount, setNoiseAmount] = useState(0.012);
  const [edgeExpand, setEdgeExpand] = useState(15);

  // Auto-scale blending defaults based on selection size.
  // Reference: 200×300 (area ~60 000) → feather 4, noise 0.012, edgeExpand 15
  // For tiny selections the values shrink proportionally so they don't blur out.
  const resetBlendingToDefaults = useCallback(() => {
    if (!bbox) {
      setFeatherRadius(4);
      setNoiseAmount(0.012);
      setEdgeExpand(15);
      return;
    }
    const minDim = Math.min(bbox.width, bbox.height);
    const area = bbox.width * bbox.height;
    const refArea = 60000;
    const s = Math.max(0.15, Math.min(1.0, Math.sqrt(area / refArea)));
    const maxFeather = Math.max(1, Math.round(minDim * 0.35));
    setFeatherRadius(Math.min(Math.round(4 * s), maxFeather));
    setNoiseAmount(parseFloat((0.012 * s).toFixed(4)));
    setEdgeExpand(Math.round(15 * s));
  }, [bbox]);

  useEffect(() => {
    resetBlendingToDefaults();
  }, [resetBlendingToDefaults]);

  // ── Redact state ────────────────────────────────────────────────────────
  const [redactColor, setRedactColor] = useState("#000000");

  // ── Text state ──────────────────────────────────────────────────────────
  const [textContent, setTextContent] = useState("");
  const [fontSize, setFontSize] = useState(12);
  const [fontColor, setFontColor] = useState("#000000");
  const [fontFamily, setFontFamily] = useState("helv");
  const [textAlign, setTextAlign] = useState(0);

  // ── Add Image state ─────────────────────────────────────────────────────
  const [addImageFile, setAddImageFile] = useState<File | null>(null);
  const [addImagePreview, setAddImagePreview] = useState<string | null>(null);
  const addImageInputRef = useRef<HTMLInputElement>(null);

  // ── AI generation handlers ──────────────────────────────────────────────
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

  const handleGeneratePreview = async () => {
    if (!pdfFile || !bbox) return;
    setStatus("generating");
    setErrorMsg("");
    try {
      const effectiveGenType = genType;
      const blob = await generateImage({
        pdf: pdfFile,
        page: pageIndex,
        bbox,
        prompt,
        generationType: effectiveGenType,
        referenceImage: refImage,
        aiModel,
        useEditApi,
        editQuality,
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
      setStatus("idle");
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

  // ── Redact handler (backend) ────────────────────────────────────────────
  const handleRedact = useCallback(async () => {
    if (!pdfFile || !bbox) return;
    setStatus("generating");
    setErrorMsg("");
    try {
      const blob = await redactRegion({ pdf: pdfFile, page: pageIndex, bbox, color: redactColor });
      onResultReady(blob);
      setStatus("idle");
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, [pdfFile, bbox, pageIndex, redactColor, onResultReady]);

  // ── Whiten handler (backend) ───────────────────────────────────────────
  const handleWhiten = useCallback(async () => {
    if (!pdfFile || !bbox) return;
    setStatus("generating");
    setErrorMsg("");
    try {
      const blob = await whitenRegion({ pdf: pdfFile, page: pageIndex, bbox });
      onResultReady(blob);
      setStatus("idle");
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, [pdfFile, bbox, pageIndex, onResultReady]);

  // ── Auto-apply for redact / whiten when bbox is drawn ──────────────────
  const autoApplyDoneRef = useRef<string | null>(null);
  useEffect(() => {
    if (!bbox) {
      autoApplyDoneRef.current = null;
      return;
    }
    const key = `${bbox.x},${bbox.y},${bbox.width},${bbox.height}`;
    if (autoApplyDoneRef.current === key) return;
    if (toolMode === "redact") {
      autoApplyDoneRef.current = key;
      handleRedact();
    } else if (toolMode === "whiten") {
      autoApplyDoneRef.current = key;
      handleWhiten();
    }
  }, [bbox, toolMode, handleRedact, handleWhiten]);

  // ── Auto-preview for addimage when bbox is drawn & image is picked ──────
  const addImageAutoRef = useRef<string | null>(null);
  useEffect(() => {
    if (toolMode !== "addimage" || !addImageFile || !bbox) {
      addImageAutoRef.current = null;
      return;
    }
    const key = `${bbox.x},${bbox.y},${bbox.width},${bbox.height}`;
    if (addImageAutoRef.current === key) return;
    addImageAutoRef.current = key;
    // Show the picked image as a draggable preview overlay
    const blob = addImageFile as Blob;
    const thumbURL = URL.createObjectURL(blob);
    setPreviewBlob(blob);
    setPreviewThumbURL(thumbURL);
    setStatus("preview");
    onPreviewReady(blob, bbox);
  }, [bbox, toolMode, addImageFile, onPreviewReady]);

  // ── Add Image confirm handler ──────────────────────────────────────────
  const handleConfirmAddImage = async () => {
    if (!pdfFile || !addImageFile || !adjustedBBox) return;
    setStatus("inserting");
    setErrorMsg("");
    try {
      const resultBlob = await insertImage({
        pdf: pdfFile,
        page: pageIndex,
        bbox: adjustedBBox,
        image: addImageFile,
        featherRadius,
        noiseAmount,
        edgeExpand,
      });
      onResultReady(resultBlob);
      setStatus("idle");
      if (previewThumbURL) URL.revokeObjectURL(previewThumbURL);
      setPreviewBlob(null);
      setPreviewThumbURL(null);
      onCancelPreview();
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  };

  // ── Add Text handler ───────────────────────────────────────────────────
  const handleAddText = async () => {
    if (!pdfFile || !bbox || !textContent.trim()) return;
    setStatus("generating");
    setErrorMsg("");
    try {
      const blob = await addText({
        pdf: pdfFile,
        page: pageIndex,
        bbox,
        text: textContent,
        fontSize,
        fontColor,
        fontFamily,
        align: textAlign,
      });
      onResultReady(blob);
      setStatus("idle");
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  };

  // ── Computed state ──────────────────────────────────────────────────────
  const isAITool = toolMode === "select";
  const isInstantTool = toolMode === "redact" || toolMode === "whiten";
  const canGenerate = !!pdfFile && !!bbox && (status === "idle" || status === "error");
  const inPreview = status === "preview";
  const isWorking = status === "generating" || status === "inserting";

  // ── Bbox info chip ──────────────────────────────────────────────────────
  const bboxChip = bbox ? (
    <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-3 py-2 text-xs text-emerald-400 font-mono">
      <span className="font-semibold text-emerald-300">Region selected</span>
      <span className="text-slate-400">
        {Math.round(bbox.width)}&times;{Math.round(bbox.height)} pt
      </span>
    </div>
  ) : (
    <div className="flex items-center gap-2 rounded-lg bg-slate-800/50 border border-[#2e3348] px-3 py-2 text-xs text-slate-500">
      {toolMode === "text"
        ? "No region selected \u2014 drag a text box on the PDF"
        : "No region selected \u2014 drag on the PDF"}
    </div>
  );

  // ── Tool icon for header ────────────────────────────────────────────────
  const ToolIcon = {
    select: Wand2,
    redact: EyeOff,
    whiten: Eraser,
    addimage: ImagePlus,
    text: Type,
  }[toolMode];

  return (
    <div className="flex flex-col h-full">
      {/* ─── Scrollable content area ─── */}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-5 px-5 pt-6 pb-4">
        {/* ── Tool header ── */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <ToolIcon size={16} className="text-indigo-400" />
            <h2 className="text-base font-semibold text-slate-100">
              {TOOL_INFO[toolMode].title}
            </h2>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            {TOOL_INFO[toolMode].desc}
          </p>
        </div>

        {/* ── Selected region indicator ── */}
        {bboxChip}

        {/* ════════════════════════════════════════════════════════════════
            AI Generation controls (select mode)
        ════════════════════════════════════════════════════════════════ */}
        {isAITool && (
          <>
            {/* AI Model Selector — hidden for now */}
            {false && toolMode === "select" && (
              <div className="space-y-2">
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                  AI Model
                </label>
                <select
                  value={aiModel}
                  onChange={(e) => setAiModel(e.target.value)}
                  className="w-full rounded-lg border border-[#2e3348] bg-[#222636] px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all"
                >
                  <optgroup label="Google Gemini">
                    <option value="gemini-3.1-flash-image-preview">Gemini 3.1 Flash Image Preview</option>
                    <option value="gemini-2.0-flash-exp-image-generation">Gemini 2.0 Flash Exp</option>
                  </optgroup>
                  <optgroup label="GPT Image — coming soon">
                    <option value="gpt-image-1" disabled>GPT Image 1 (disabled)</option>
                    <option value="gpt-image-1-mini" disabled>GPT Image 1 Mini (disabled)</option>
                    <option value="gpt-image-1.5" disabled>GPT Image 1.5 (disabled)</option>
                    <option value="chatgpt-image-latest" disabled>ChatGPT Image latest (disabled)</option>
                  </optgroup>
                  <optgroup label="DALL·E — coming soon">
                    <option value="dall-e-3" disabled>DALL·E 3 (disabled)</option>
                    <option value="dall-e-2" disabled>DALL·E 2 (disabled)</option>
                  </optgroup>
                </select>

                {/* Edit mode toggle — only meaningful for GPT image models (not Gemini) */}
                {!aiModel.startsWith("gemini") && aiModel !== "dall-e-3" && (
                  <div className="flex items-center justify-between rounded-lg border border-[#2e3348] bg-[#222636] px-3 py-2">
                    <div>
                      <p className="text-xs font-medium text-slate-300">Edit Region Mode</p>
                      <p className="text-[10px] text-slate-500 mt-0.5">Use the selected region as source image</p>
                    </div>
                    <button
                      onClick={() => setUseEditApi((v) => !v)}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                        useEditApi ? "bg-indigo-500" : "bg-slate-600"
                      }`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
                          useEditApi ? "translate-x-4" : "translate-x-1"
                        }`}
                      />
                    </button>
                  </div>
                )}

                {/* Quality selector (GPT image edit mode only) */}
                {useEditApi && aiModel !== "dall-e-3" && aiModel !== "dall-e-2" && (
                  <div className="space-y-1">
                    <label className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">Edit Quality</label>
                    <div className="grid grid-cols-4 gap-1">
                      {(["auto", "low", "medium", "high"] as const).map((q) => (
                        <button
                          key={q}
                          onClick={() => setEditQuality(q)}
                          className={`rounded px-2 py-1 text-[10px] font-medium transition-all ${
                            editQuality === q
                              ? "bg-indigo-500 text-white"
                              : "bg-[#1a1f2e] border border-[#2e3348] text-slate-400 hover:border-indigo-500/40"
                          }`}
                        >
                          {q.charAt(0).toUpperCase() + q.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Generation Type (only in "select" mode) */}
            {toolMode === "select" && !useEditApi && (
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
            )}

            {/* Prompt */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                Prompt
              </label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
                placeholder={
                  useEditApi
                    ? "Describe how to edit this region… e.g. \"Replace the text with a handwritten signature\""
                    : "Describe what should be generated…"
                }
                className="w-full rounded-lg border border-[#2e3348] bg-[#222636] px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 resize-none transition-all"
              />
              {useEditApi && (
                <p className="text-[10px] text-indigo-400/70">
                  The selected region will be sent to the AI as the source image to edit.
                </p>
              )}
            </div>

            {/* Reference Image — hidden in edit mode (region is the source) */}
            {!useEditApi && (
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
            )}

            {/* Blending Controls */}
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
                      <span className="text-[11px] text-slate-500 font-mono">{featherRadius}px</span>
                    </div>
                    <input
                      type="range" min={0} max={15} step={1}
                      value={featherRadius}
                      onChange={(e) => setFeatherRadius(Number(e.target.value))}
                      className="w-full accent-indigo-500 h-1.5 rounded-full appearance-none bg-slate-700 cursor-pointer"
                    />
                    <div className="flex justify-between text-[9px] text-slate-600">
                      <span>Hard</span><span>Soft</span>
                    </div>
                  </div>
                  {/* Noise Amount */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <label className="text-[11px] text-slate-400">Grain / Noise</label>
                      <span className="text-[11px] text-slate-500 font-mono">{(noiseAmount * 100).toFixed(1)}%</span>
                    </div>
                    <input
                      type="range" min={0} max={0.05} step={0.002}
                      value={noiseAmount}
                      onChange={(e) => setNoiseAmount(Number(e.target.value))}
                      className="w-full accent-indigo-500 h-1.5 rounded-full appearance-none bg-slate-700 cursor-pointer"
                    />
                    <div className="flex justify-between text-[9px] text-slate-600">
                      <span>None</span><span>Heavy</span>
                    </div>
                  </div>
                  {/* Edge Expand */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <label className="text-[11px] text-slate-400">Edge Expand</label>
                      <span className="text-[11px] text-slate-500 font-mono">{edgeExpand}pt</span>
                    </div>
                    <input
                      type="range" min={0} max={30} step={1}
                      value={edgeExpand}
                      onChange={(e) => setEdgeExpand(Number(e.target.value))}
                      className="w-full accent-indigo-500 h-1.5 rounded-full appearance-none bg-slate-700 cursor-pointer"
                    />
                    <div className="flex justify-between text-[9px] text-slate-600">
                      <span>None</span><span>Wide</span>
                    </div>
                  </div>
                  <button
                    onClick={resetBlendingToDefaults}
                    className="w-full text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors"
                  >
                    Reset to defaults
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {/* ════════════════════════════════════════════════════════════════
            Redact controls
        ════════════════════════════════════════════════════════════════ */}
        {toolMode === "redact" && (
          <div className="space-y-3">
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
              Redaction Color
            </label>
            <div className="flex items-center gap-2 flex-wrap">
              {REDACT_COLOR_PRESETS.map((c) => (
                <button
                  key={c.value}
                  onClick={() => setRedactColor(c.value)}
                  className={`color-swatch ${redactColor === c.value ? "active" : ""}`}
                  style={{ background: c.value }}
                  title={c.label}
                />
              ))}
            </div>
            {isWorking && (
              <div className="flex items-center gap-2 rounded-lg bg-indigo-500/10 border border-indigo-500/30 px-3 py-2">
                <div className="spinner" />
                <span className="text-xs text-indigo-300">Applying redaction…</span>
              </div>
            )}
            {!isWorking && (
              <p className="text-[10px] text-slate-600">
                Draw a region on the PDF — it will be redacted automatically.
              </p>
            )}
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════
            Whiten controls
        ════════════════════════════════════════════════════════════════ */}
        {toolMode === "whiten" && (
          <div className="space-y-3">
            {isWorking && (
              <div className="flex items-center gap-2 rounded-lg bg-indigo-500/10 border border-indigo-500/30 px-3 py-2">
                <div className="spinner" />
                <span className="text-xs text-indigo-300">Whitening region…</span>
              </div>
            )}
            {!isWorking && (
              <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-3 py-3">
                <p className="text-xs text-yellow-200/80">
                  Draw a region on the PDF — it will be erased (whitened) automatically.
                </p>
              </div>
            )}
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════
            Add Image controls
        ════════════════════════════════════════════════════════════════ */}
        {toolMode === "addimage" && (
          <div className="space-y-4">
            {/* Image picker */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                Image
              </label>
              {addImagePreview ? (
                <div className="relative group rounded-lg overflow-hidden border border-[#2e3348]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={addImagePreview}
                    alt="Selected"
                    className="w-full h-36 object-contain bg-[#222636]"
                  />
                  <button
                    onClick={() => {
                      if (addImagePreview) URL.revokeObjectURL(addImagePreview);
                      setAddImageFile(null);
                      setAddImagePreview(null);
                      if (addImageInputRef.current) addImageInputRef.current.value = "";
                      // Also cancel any preview overlay
                      if (previewThumbURL) URL.revokeObjectURL(previewThumbURL);
                      setPreviewBlob(null);
                      setPreviewThumbURL(null);
                      setStatus("idle");
                      onCancelPreview();
                    }}
                    className="absolute top-2 right-2 rounded-full bg-red-600/80 p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X size={12} />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => addImageInputRef.current?.click()}
                  className="w-full rounded-lg border border-dashed border-[#2e3348] hover:border-indigo-500/50 bg-[#222636] px-3 py-6 text-sm text-slate-500 hover:text-slate-300 flex flex-col items-center justify-center gap-2 transition-all"
                >
                  <ImagePlus size={24} className="text-slate-600" />
                  <span>Pick an image from your device</span>
                  <span className="text-[10px] text-slate-600">PNG, JPG, SVG, WebP</span>
                </button>
              )}
              <input
                ref={addImageInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  setAddImageFile(f);
                  if (addImagePreview) URL.revokeObjectURL(addImagePreview);
                  setAddImagePreview(URL.createObjectURL(f));
                }}
              />
            </div>

            {/* Instructions */}
            {addImageFile && !bbox && status === "idle" && (
              <div className="rounded-lg border border-indigo-500/20 bg-indigo-500/5 px-3 py-3">
                <p className="text-xs text-indigo-200/80">
                  Now <strong>drag a rectangle</strong> on the PDF where you want to place the image.
                </p>
              </div>
            )}

            {/* Working indicator */}
            {isWorking && (
              <div className="flex items-center gap-2 rounded-lg bg-indigo-500/10 border border-indigo-500/30 px-3 py-2">
                <div className="spinner" />
                <span className="text-xs text-indigo-300">
                  {status === "inserting" ? "Inserting image…" : "Processing…"}
                </span>
              </div>
            )}

            {/* Blending Controls (for image insertion) */}
            {addImageFile && (
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
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <label className="text-[11px] text-slate-400">Edge Feather</label>
                        <span className="text-[11px] text-slate-500 font-mono">{featherRadius}px</span>
                      </div>
                      <input
                        type="range" min={0} max={15} step={1}
                        value={featherRadius}
                        onChange={(e) => setFeatherRadius(Number(e.target.value))}
                        className="w-full accent-indigo-500 h-1.5 rounded-full appearance-none bg-slate-700 cursor-pointer"
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <label className="text-[11px] text-slate-400">Grain / Noise</label>
                        <span className="text-[11px] text-slate-500 font-mono">{(noiseAmount * 100).toFixed(1)}%</span>
                      </div>
                      <input
                        type="range" min={0} max={0.05} step={0.002}
                        value={noiseAmount}
                        onChange={(e) => setNoiseAmount(Number(e.target.value))}
                        className="w-full accent-indigo-500 h-1.5 rounded-full appearance-none bg-slate-700 cursor-pointer"
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <label className="text-[11px] text-slate-400">Edge Expand</label>
                        <span className="text-[11px] text-slate-500 font-mono">{edgeExpand}pt</span>
                      </div>
                      <input
                        type="range" min={0} max={30} step={1}
                        value={edgeExpand}
                        onChange={(e) => setEdgeExpand(Number(e.target.value))}
                        className="w-full accent-indigo-500 h-1.5 rounded-full appearance-none bg-slate-700 cursor-pointer"
                      />
                    </div>
                    <button
                      onClick={resetBlendingToDefaults}
                      className="w-full text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors"
                    >
                      Reset to defaults
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════
            Text controls
        ════════════════════════════════════════════════════════════════ */}
        {toolMode === "text" && (
          <>
            {/* Text content */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                Text
              </label>
              <textarea
                value={textContent}
                onChange={(e) => setTextContent(e.target.value)}
                rows={4}
                placeholder="Type the text to place on the PDF\u2026"
                className="w-full rounded-lg border border-[#2e3348] bg-[#222636] px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 resize-none transition-all"
              />
            </div>

            {/* Font Family */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                Font
              </label>
              <div className="grid grid-cols-3 gap-2">
                {FONT_FAMILIES.map((f) => (
                  <button
                    key={f.value}
                    onClick={() => setFontFamily(f.value)}
                    className={`rounded-lg border px-2 py-1.5 text-xs text-center transition-all ${
                      fontFamily === f.value
                        ? "border-indigo-500 bg-indigo-500/10 text-indigo-300"
                        : "border-[#2e3348] bg-[#222636] text-slate-400 hover:border-indigo-500/40"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Font Size */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                  Size
                </label>
                <span className="text-xs text-slate-500 font-mono">{fontSize}pt</span>
              </div>
              <input
                type="range"
                min={8} max={48} step={1}
                value={fontSize}
                onChange={(e) => setFontSize(Number(e.target.value))}
                className="w-full accent-indigo-500 h-1.5 rounded-full appearance-none bg-slate-700 cursor-pointer"
              />
              <div className="flex flex-wrap gap-1">
                {FONT_SIZES.filter((s) => [8, 12, 16, 24, 36, 48].includes(s)).map((s) => (
                  <button
                    key={s}
                    onClick={() => setFontSize(s)}
                    className={`px-2 py-0.5 rounded text-[10px] border transition-all ${
                      fontSize === s
                        ? "border-indigo-500 text-indigo-300 bg-indigo-500/10"
                        : "border-[#2e3348] text-slate-500 hover:text-slate-300"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {/* Font Color */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                Color
              </label>
              <div className="flex items-center gap-2 flex-wrap">
                {COLOR_PRESETS.map((c) => (
                  <button
                    key={c.value}
                    onClick={() => setFontColor(c.value)}
                    className={`color-swatch ${fontColor === c.value ? "active" : ""}`}
                    style={{ background: c.value }}
                    title={c.label}
                  />
                ))}
              </div>
            </div>

            {/* Text Alignment */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                Alignment
              </label>
              <div className="flex items-center gap-2">
                {ALIGN_OPTIONS.map((a) => (
                  <button
                    key={a.value}
                    onClick={() => setTextAlign(a.value)}
                    className={`p-2 rounded-lg border transition-all ${
                      textAlign === a.value
                        ? "border-indigo-500 bg-indigo-500/10 text-indigo-300"
                        : "border-[#2e3348] bg-[#222636] text-slate-400 hover:border-indigo-500/40"
                    }`}
                    title={a.label}
                  >
                    <a.icon size={14} />
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>{/* end scrollable area */}

      {/* ─── Pinned bottom section ─── */}
      <div className="shrink-0 flex flex-col gap-3 px-5 pt-4 pb-5 border-t border-[#1f2335]">

        {/* ── Preview thumbnail (AI & addimage tools, in preview state) ── */}
        {(isAITool || toolMode === "addimage") && (inPreview || status === "inserting") && previewThumbURL && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                Preview
              </label>
              <a
                href={previewThumbURL}
                download={`preview_${Date.now()}.png`}
                className="flex items-center gap-1 text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                <Download size={11} />
                Save
              </a>
            </div>
            <div className="relative group rounded-lg overflow-hidden border border-indigo-500/40 bg-[#222636]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewThumbURL}
                alt="Generated preview"
                className="w-full object-contain max-h-32"
              />
              <a
                href={previewThumbURL}
                download={`preview_${Date.now()}.png`}
                className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Download size={20} className="text-white" />
              </a>
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

        {/* ── Undo button (always visible when undo is available) ── */}
        {canUndo && (
          <button
            onClick={onUndo}
            className="w-full flex items-center justify-center gap-2 rounded-xl border border-amber-500/40 hover:bg-amber-500/10 text-amber-400 py-2.5 text-sm transition-all"
          >
            <RotateCcw size={14} />
            Undo Last Edit
          </button>
        )}

        {/* ── Action buttons ── */}
        {!isInstantTool && (
          <div className="space-y-2">

            {/* ─── AI tools: Generate / Confirm flow ─── */}
            {isAITool && (
              <>
                {!inPreview && (
                  <button
                    onClick={handleGeneratePreview}
                    disabled={!canGenerate || isWorking}
                    className="w-full flex items-center justify-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-3 text-sm transition-all shadow-lg"
                  >
                    {status === "generating" ? (
                      <>
                        <div className="spinner" />
                        Generating&hellip;
                      </>
                    ) : (
                      <>
                        <Wand2 size={16} />
                        Generate Preview
                      </>
                    )}
                  </button>
                )}

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
                          Applying&hellip;
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
              </>
            )}

            {/* ─── Text: apply ─── */}
            {toolMode === "text" && (
              <button
                onClick={handleAddText}
                disabled={!canGenerate || !textContent.trim() || isWorking}
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-3 text-sm transition-all shadow-lg"
              >
                {isWorking ? (
                  <>
                    <div className="spinner" />
                    Applying&hellip;
                  </>
                ) : (
                  <>
                    <Type size={16} />
                    Add Text
                  </>
                )}
              </button>
            )}

            {/* ─── Add Image: confirm / cancel ─── */}
            {toolMode === "addimage" && (
              <>
                {!addImageFile && (
                  <p className="text-[10px] text-slate-600 text-center">
                    Pick an image above to get started.
                  </p>
                )}

                {addImageFile && !inPreview && !isWorking && (
                  <p className="text-[10px] text-slate-600 text-center">
                    Draw a rectangle on the PDF to place the image.
                  </p>
                )}

                {(inPreview || status === "inserting") && (
                  <>
                    <button
                      onClick={handleConfirmAddImage}
                      disabled={!adjustedBBox || isWorking}
                      className="w-full flex items-center justify-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-3 text-sm transition-all shadow-lg"
                    >
                      {isWorking ? (
                        <>
                          <div className="spinner" />
                          Inserting&hellip;
                        </>
                      ) : (
                        <>
                          <CheckCircle size={16} />
                          Confirm &amp; Apply
                        </>
                      )}
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
              </>
            )}

            {/* Reset / new file (always available when not in preview) */}
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
