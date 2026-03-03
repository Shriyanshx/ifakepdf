"use client";

/**
 * PDFViewer
 * ─────────
 * Renders a PDF page using PDF.js and supports two interaction modes:
 *
 * 1. DRAW MODE  (previewOverlay == null)
 *    User drags to select a bounding box. Coordinates are emitted in PDF user
 *    space (origin = bottom-left, y increases upward — standard PDF coords as
 *    returned by PDF.js convertToPdfPoint).
 *
 * 2. PREVIEW MODE  (previewOverlay != null)
 *    Shows the generated image as a draggable overlay. Dragging it updates the
 *    bbox via onPreviewMove so the user can fine-tune placement before inserting.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import * as pdfjs from "pdfjs-dist";

if (typeof window !== "undefined") {
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url
  ).toString();
}

export interface BBox {
  /** PDF user-space points, origin = bottom-left of page */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewOverlay {
  imageURL: string;
  bbox: BBox;
}

interface PDFViewerProps {
  file: File;
  pageIndex: number;
  totalPages: number;
  onPageChange: (n: number) => void;
  /** Emitted in draw mode when user finishes dragging a selection */
  onBBoxSelect: (bbox: BBox) => void;
  /** Green border shown around the original selection */
  activeBBox: BBox | null;
  /** When set, renders a draggable image overlay instead of draw cursor */
  previewOverlay?: PreviewOverlay | null;
  /** Emitted when user drags the preview image to a new position */
  onPreviewMove?: (newBBox: BBox) => void;
  scale?: number;
}

interface DrawDrag {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

interface PreviewDrag {
  startCanvasX: number;
  startCanvasY: number;
  startBBox: BBox;
}

export default function PDFViewer({
  file,
  pageIndex,
  totalPages,
  onPageChange,
  onBBoxSelect,
  activeBBox,
  previewOverlay = null,
  onPreviewMove,
  scale = 1.5,
}: PDFViewerProps) {
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const pdfDocRef = useRef<pdfjs.PDFDocumentProxy | null>(null);
  const viewportRef = useRef<pdfjs.PageViewport | null>(null);

  const [drawDrag, setDrawDrag] = useState<DrawDrag | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [previewDrag, setPreviewDrag] = useState<PreviewDrag | null>(null);
  const [loading, setLoading] = useState(true);

  // ── Load PDF ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const bytes = await file.arrayBuffer();
      const doc = await pdfjs.getDocument({ data: bytes }).promise;
      if (cancelled) return;
      pdfDocRef.current = doc;
      renderPage(doc, pageIndex);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  useEffect(() => {
    if (pdfDocRef.current) renderPage(pdfDocRef.current, pageIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIndex, scale]);

  const renderPage = async (doc: pdfjs.PDFDocumentProxy, idx: number) => {
    setLoading(true);
    const page = await doc.getPage(idx + 1);
    const viewport = page.getViewport({ scale });
    viewportRef.current = viewport;

    const canvas = pdfCanvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = viewport.width * dpr;
    canvas.height = viewport.height * dpr;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    await page.render({ canvas, viewport }).promise;
    setLoading(false);
  };

  // ── Coordinate helpers ────────────────────────────────────────────────────
  const getRelativePos = (e: React.MouseEvent) => {
    const rect = overlayRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  /** Canvas CSS px → PDF user-space points */
  const canvasToPDF = useCallback((cx: number, cy: number) => {
    const vp = viewportRef.current!;
    const [px, py] = vp.convertToPdfPoint(cx, cy);
    return { px, py };
  }, []);

  /** PDF user-space points → canvas CSS px */
  const pdfToCanvas = useCallback((px: number, py: number) => {
    const vp = viewportRef.current!;
    const [cx, cy] = vp.convertToViewportPoint(px, py);
    return { cx, cy };
  }, []);

  // ── Determine if a canvas point is inside the preview bbox ───────────────
  const isInsidePreview = useCallback(
    (canvasX: number, canvasY: number): boolean => {
      if (!previewOverlay || !viewportRef.current) return false;
      const { bbox } = previewOverlay;
      // The four corners of the bbox in PDF user space:
      const tl = pdfToCanvas(bbox.x, bbox.y + bbox.height);
      const br = pdfToCanvas(bbox.x + bbox.width, bbox.y);
      const left = Math.min(tl.cx, br.cx);
      const top = Math.min(tl.cy, br.cy);
      const right = Math.max(tl.cx, br.cx);
      const bottom = Math.max(tl.cy, br.cy);
      return canvasX >= left && canvasX <= right && canvasY >= top && canvasY <= bottom;
    },
    [previewOverlay, pdfToCanvas]
  );

  // ── Mouse handlers ────────────────────────────────────────────────────────
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const { x, y } = getRelativePos(e);

    if (previewOverlay && isInsidePreview(x, y)) {
      // Start dragging the preview image
      setPreviewDrag({ startCanvasX: x, startCanvasY: y, startBBox: previewOverlay.bbox });
    } else {
      // Start drawing a selection (draw mode)
      setIsDrawing(true);
      setDrawDrag({ startX: x, startY: y, endX: x, endY: y });
    }
  };

  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const { x, y } = getRelativePos(e);

    if (previewDrag) {
      // Move the preview image
      const dx = x - previewDrag.startCanvasX;
      const dy = y - previewDrag.startCanvasY;
      // Convert canvas pixel delta → PDF point delta using scale
      const dxPt = dx / scale;
      const dyPt = -(dy / scale); // flip y: canvas y increases down, PDF y increases up
      const newBBox: BBox = {
        x: previewDrag.startBBox.x + dxPt,
        y: previewDrag.startBBox.y + dyPt,
        width: previewDrag.startBBox.width,
        height: previewDrag.startBBox.height,
      };
      onPreviewMove?.(newBBox);
    } else if (isDrawing && drawDrag) {
      setDrawDrag((d) => d && { ...d, endX: x, endY: y });
    }
  };

  const onMouseUp = () => {
    if (previewDrag) {
      setPreviewDrag(null);
      return;
    }

    if (!drawDrag || !isDrawing) return;
    setIsDrawing(false);

    const x0 = Math.min(drawDrag.startX, drawDrag.endX);
    const y0 = Math.min(drawDrag.startY, drawDrag.endY);
    const x1 = Math.max(drawDrag.startX, drawDrag.endX);
    const y1 = Math.max(drawDrag.startY, drawDrag.endY);

    if (x1 - x0 < 8 || y1 - y0 < 8) { setDrawDrag(null); return; }

    // Convert corners to PDF user space
    const tl = canvasToPDF(x0, y0);
    const br = canvasToPDF(x1, y1);

    onBBoxSelect({
      x: Math.min(tl.px, br.px),
      y: Math.min(tl.py, br.py),
      width: Math.abs(br.px - tl.px),
      height: Math.abs(br.py - tl.py),
    });
    setDrawDrag(null);
  };

  // ── Styles ────────────────────────────────────────────────────────────────
  const liveSelectionStyle = drawDrag && isDrawing
    ? {
        left: Math.min(drawDrag.startX, drawDrag.endX),
        top: Math.min(drawDrag.startY, drawDrag.endY),
        width: Math.abs(drawDrag.endX - drawDrag.startX),
        height: Math.abs(drawDrag.endY - drawDrag.startY),
      }
    : null;

  /** Convert a PDF-user-space BBox to a CSS pixel rect for display */
  const bboxToCanvasStyle = useCallback((bbox: BBox) => {
    if (!viewportRef.current) return null;
    const tl = pdfToCanvas(bbox.x, bbox.y + bbox.height); // top-left in canvas
    const br = pdfToCanvas(bbox.x + bbox.width, bbox.y);  // bottom-right in canvas
    return {
      left: Math.min(tl.cx, br.cx),
      top: Math.min(tl.cy, br.cy),
      width: Math.abs(br.cx - tl.cx),
      height: Math.abs(br.cy - tl.cy),
    };
  }, [pdfToCanvas]);

  const confirmedStyle = activeBBox && !isDrawing ? bboxToCanvasStyle(activeBBox) : null;
  const previewStyle = previewOverlay ? bboxToCanvasStyle(previewOverlay.bbox) : null;

  const cursor = previewDrag ? "grabbing" : previewOverlay ? "grab" : "crosshair";

  return (
    <div className="flex flex-col items-center gap-4 w-full">
      {/* Hint text */}
      {previewOverlay ? (
        <p className="text-xs text-indigo-400 bg-indigo-500/10 border border-indigo-500/30 rounded-full px-4 py-1.5">
          Drag the image to reposition → click <strong>Confirm & Apply</strong> when ready
        </p>
      ) : (
        <p className="text-xs text-slate-500">Drag on the page to select a region</p>
      )}

      {/* ── PDF Canvas ── */}
      <div className="pdf-canvas-wrapper shadow-2xl rounded overflow-hidden">
        <canvas ref={pdfCanvasRef} />

        {/* Interaction overlay — must be above everything to capture all mouse events */}
        <div
          ref={overlayRef}
          className="absolute inset-0 z-30"
          style={{ cursor }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
        />

        {/* Live draw selection */}
        {liveSelectionStyle && (
          <div className="selection-overlay" style={liveSelectionStyle} />
        )}

        {/* Confirmed selection bbox (green) */}
        {confirmedStyle && !previewOverlay && (
          <div
            className="selection-overlay"
            style={{
              ...confirmedStyle,
              borderColor: "#34d399",
              background: "rgba(52,211,153,0.08)",
            }}
          />
        )}

        {/* ── Draggable preview image — pointer-events-none so clicks pass to the overlay above ── */}
        {previewStyle && previewOverlay && (
          <div
            className="absolute z-20 ring-2 ring-indigo-400 shadow-xl pointer-events-none"
            style={{
              left: previewStyle.left,
              top: previewStyle.top,
              width: previewStyle.width,
              height: previewStyle.height,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewOverlay.imageURL}
              alt="AI generated preview"
              className="w-full h-full object-fill select-none pointer-events-none"
              draggable={false}
            />
            {/* Corner label */}
            <div className="absolute -top-5 left-0 text-[10px] text-indigo-300 bg-indigo-600/80 rounded-sm px-1.5 py-0.5 whitespace-nowrap">
              drag to reposition
            </div>
          </div>
        )}

        {/* Loading overlay */}
        {loading && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#0f1117]/80 rounded">
            <div className="spinner" />
          </div>
        )}
      </div>

      {/* ── Page controls ── */}
      <div className="flex items-center gap-3 text-sm text-slate-400">
        <button
          onClick={() => onPageChange(Math.max(0, pageIndex - 1))}
          disabled={pageIndex === 0}
          className="px-3 py-1.5 rounded-lg border border-[#2e3348] hover:bg-[#2e3348] disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          ← Prev
        </button>
        <span className="font-mono">{pageIndex + 1} / {totalPages}</span>
        <button
          onClick={() => onPageChange(Math.min(totalPages - 1, pageIndex + 1))}
          disabled={pageIndex === totalPages - 1}
          className="px-3 py-1.5 rounded-lg border border-[#2e3348] hover:bg-[#2e3348] disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          Next →
        </button>
      </div>
    </div>
  );
}
