"use client";

/**
 * ifakepdf – main page
 *
 * Layout:
 *  ┌─ Header ──────────────────────────────────────────┐
 *  │  Logo + file name                                  │
 *  ├─ Toolbar ─────────────────────────────────────────┤
 *  │  [Edit Region] [Redact] [Whiten] [Signature] [Text]│
 *  ├─────────────────────────────┬─────────────────────┤
 *  │  PDF Viewer (left)          │  Side Panel (right)  │
 *  │  PDF.js render              │  Tool-specific opts   │
 *  │  Bounding-box canvas overlay│  Generate / Apply     │
 *  │  Page nav                   │  Download             │
 *  └─────────────────────────────┴─────────────────────┘
 */

import { useState, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import Image from "next/image";
import {
  FileText,
  Download,
  X,
  Undo2,
  Wand2,
  EyeOff,
  Eraser,
  ImagePlus,
  Type,
} from "lucide-react";
import FileDropzone from "@/components/FileDropzone";
import EditPanel from "@/components/EditPanel";
import type { BBox } from "@/components/PDFViewer";

// Dynamic import to prevent SSR (PDF.js requires browser APIs)
const PDFViewer = dynamic(() => import("@/components/PDFViewer"), {
  ssr: false,
});

export type ToolMode = "select" | "redact" | "whiten" | "addimage" | "text";

const TOOLS: { mode: ToolMode; label: string; icon: typeof Wand2 }[] = [
  { mode: "select",    label: "Edit Region",   icon: Wand2 },
  { mode: "redact",    label: "Redact",        icon: EyeOff },
  { mode: "whiten",    label: "Whiten",        icon: Eraser },
  { mode: "addimage",  label: "Add Image",     icon: ImagePlus },
  { mode: "text",      label: "Add Text",      icon: Type },
];

export default function Home() {
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [bbox, setBbox] = useState<BBox | null>(null);
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);
  const [resultURL, setResultURL] = useState<string | null>(null);
  // Preview state for two-step generation flow
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [previewImageURL, setPreviewImageURL] = useState<string | null>(null);
  const [adjustedBBox, setAdjustedBBox] = useState<BBox | null>(null);
  const downloadLinkRef = useRef<HTMLAnchorElement>(null);

  // ── Undo stack ─────────────────────────────────────────────────────────
  const [undoStack, setUndoStack] = useState<File[]>([]);

  // ── Tool mode ──────────────────────────────────────────────────────────
  const [toolMode, setToolMode] = useState<ToolMode>("select");

  const handleToolChange = useCallback(
    (mode: ToolMode) => {
      setToolMode(mode);
      // Clear selection and preview state when switching tools
      setBbox(null);
      if (previewImageURL) URL.revokeObjectURL(previewImageURL);
      setPreviewBlob(null);
      setPreviewImageURL(null);
      setAdjustedBBox(null);
    },
    [previewImageURL]
  );

  // ── File selection ─────────────────────────────────────────────────────
  const handleFile = useCallback((file: File) => {
    setPdfFile(file);
    setPageIndex(0);
    setBbox(null);
    setResultBlob(null);
    setResultURL(null);

    import("pdfjs-dist").then(async (pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url
      ).toString();
      const bytes = await file.arrayBuffer();
      const doc = await pdfjs.getDocument({ data: bytes }).promise;
      setTotalPages(doc.numPages);
    });
  }, []);

  // ── AI result ready ────────────────────────────────────────────────────
  const handleResultReady = useCallback(
    (blob: Blob) => {
      // Push current file onto undo stack before replacing
      if (pdfFile) {
        setUndoStack((prev) => [...prev, pdfFile]);
      }
      if (resultURL) URL.revokeObjectURL(resultURL);
      const url = URL.createObjectURL(blob);
      setResultBlob(blob);
      setResultURL(url);
      const modified = new File([blob], "modified.pdf", {
        type: "application/pdf",
      });
      setPdfFile(modified);
      setBbox(null);
    },
    [resultURL, pdfFile]
  );

  // ── Undo ───────────────────────────────────────────────────────────────
  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    if (resultURL) URL.revokeObjectURL(resultURL);
    const url = URL.createObjectURL(prev);
    setResultBlob(prev);
    setResultURL(url);
    setPdfFile(prev);
    setBbox(null);
  }, [undoStack, resultURL]);

  // ── Preview management (two-step flow) ────────────────────────────────
  const handlePreviewReady = useCallback((blob: Blob, initialBBox: BBox) => {
    if (previewImageURL) URL.revokeObjectURL(previewImageURL);
    const url = URL.createObjectURL(blob);
    setPreviewBlob(blob);
    setPreviewImageURL(url);
    setAdjustedBBox(initialBBox);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCancelPreview = useCallback(() => {
    if (previewImageURL) URL.revokeObjectURL(previewImageURL);
    setPreviewBlob(null);
    setPreviewImageURL(null);
    setAdjustedBBox(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewImageURL]);

  // ── Download ───────────────────────────────────────────────────────────
  const handleDownload = () => {
    if (!resultURL) return;
    const a = downloadLinkRef.current!;
    a.href = resultURL;
    a.download = `ifakepdf_${Date.now()}.pdf`;
    a.click();
  };

  // ── Reset ──────────────────────────────────────────────────────────────
  const handleReset = () => {
    setPdfFile(null);
    setBbox(null);
    setResultBlob(null);
    if (resultURL) URL.revokeObjectURL(resultURL);
    setResultURL(null);
    if (previewImageURL) URL.revokeObjectURL(previewImageURL);
    setPreviewBlob(null);
    setPreviewImageURL(null);
    setAdjustedBBox(null);
    setPageIndex(0);
    setTotalPages(1);
    setToolMode("select");
    setUndoStack([]);
  };

  // ── Landing ────────────────────────────────────────────────────────────
  if (!pdfFile) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center px-6">
        <div className="mb-10 text-center space-y-3">
          <div className="inline-flex items-center gap-3 text-2xl font-bold text-slate-100">
            <Image src="/logo.svg" alt="ifakepdf logo" width={36} height={44} priority />
            ifakepdf
          </div>
          <p className="text-slate-400 text-sm max-w-sm">
            Select any area on a PDF and let AI generate a signature, stamp,
            seal, or handwriting to fill it seamlessly.
          </p>
        </div>
        <div className="w-full max-w-md">
          <FileDropzone onFile={handleFile} />
        </div>
        <p className="mt-8 text-xs text-slate-600">
          Files are processed on our servers — never stored anywhere.
        </p>
      </main>
    );
  }

  // ── Main editor ────────────────────────────────────────────────────────
  return (
    <main className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-[#1f2335] bg-[#0f1117]/90 backdrop-blur px-6 py-3">
        <div className="flex items-center gap-3">
          <Image src="/logo.svg" alt="ifakepdf logo" width={22} height={27} />
          <span className="font-bold text-slate-100">ifakepdf</span>
          <span className="text-[#2e3348]">·</span>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <FileText size={13} className="text-slate-500" />
            <span className="max-w-[200px] truncate">{pdfFile.name}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {undoStack.length > 0 && (
            <button
              onClick={handleUndo}
              className="flex items-center gap-2 rounded-lg border border-[#2e3348] hover:bg-[#2e3348] text-slate-400 text-xs px-3 py-2 transition-all"
            >
              <Undo2 size={13} />
              Undo
            </button>
          )}
          {resultBlob && (
            <button
              onClick={handleDownload}
              className="flex items-center gap-2 rounded-lg bg-emerald-600/90 hover:bg-emerald-500 text-white text-xs font-semibold px-4 py-2 transition-all shadow"
            >
              <Download size={14} />
              Download PDF
            </button>
          )}
          <button
            onClick={handleReset}
            className="flex items-center gap-2 rounded-lg border border-[#2e3348] hover:bg-[#2e3348] text-slate-400 text-xs px-3 py-2 transition-all"
          >
            <X size={13} />
            Close
          </button>
        </div>
      </header>

      {/* Toolbar */}
      <div className="toolbar">
        {TOOLS.map((tool) => (
          <button
            key={tool.mode}
            onClick={() => handleToolChange(tool.mode)}
            className={`toolbar-btn ${toolMode === tool.mode ? "active" : ""}`}
          >
            <tool.icon size={14} />
            {tool.label}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="flex flex-1">
        {/* PDF Viewer — scrolls naturally with the page */}
        <div className="flex-1 min-w-0 flex justify-center bg-[#0f1117] px-6 py-8">
          <PDFViewer
            file={pdfFile}
            pageIndex={pageIndex}
            totalPages={totalPages}
            onPageChange={setPageIndex}
            onBBoxSelect={setBbox}
            activeBBox={bbox}
            previewOverlay={
              previewBlob && adjustedBBox && previewImageURL
                ? { imageURL: previewImageURL, bbox: adjustedBBox }
                : null
            }
            onPreviewMove={setAdjustedBBox}
            toolMode={toolMode}
          />
        </div>

        {/* Edit Panel — sticky so it stays visible while scrolling the PDF */}
        <aside className="w-80 shrink-0 border-l border-[#1f2335] bg-[#1a1d27] sticky top-[89px] h-[calc(100vh-89px)] flex flex-col overflow-hidden">
          <EditPanel
            pdfFile={pdfFile}
            pageIndex={pageIndex}
            toolMode={toolMode}
            bbox={bbox}
            adjustedBBox={adjustedBBox}
            onResultReady={handleResultReady}
            onReset={handleReset}
            onPreviewReady={handlePreviewReady}
            onCancelPreview={handleCancelPreview}
            resultURL={resultURL}
            onDownload={handleDownload}
            onUndo={handleUndo}
            canUndo={undoStack.length > 0}
          />
        </aside>
      </div>

      {/* Hidden download anchor */}
      {/* eslint-disable-next-line jsx-a11y/anchor-has-content */}
      <a ref={downloadLinkRef} className="hidden" />
    </main>
  );
}
