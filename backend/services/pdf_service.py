"""
PDF Service – redact a region and insert an image using PyMuPDF.
"""

from __future__ import annotations
import io
from typing import Tuple

import fitz  # PyMuPDF


class PDFService:
    """Handles all PDF manipulation: redaction, image insertion, cropping."""

    # ── Redact + insert ───────────────────────────────────────────────────────
    def redact_and_insert(
        self,
        pdf_bytes: bytes,
        page_index: int,
        bbox: Tuple[float, float, float, float],
        image_bytes: bytes,
    ) -> bytes:
        """
        1. Opens the PDF from bytes.
        2. White-fills (redacts) the bounding box on the target page.
        3. Inserts the generated image at exactly that rectangle.
        4. Returns the modified PDF as bytes.

        Args:
            pdf_bytes:   Raw bytes of the original PDF.
            page_index:  0-based page number.
            bbox:        (x, y, width, height) in PDF user-space points.
                         Origin = bottom-left (PDF standard).
            image_bytes: PNG/JPEG bytes of the generated image.
        """
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")

        if page_index >= len(doc):
            raise ValueError(
                f"Page index {page_index} out of range (document has {len(doc)} pages)"
            )

        page = doc[page_index]
        x, y, w, h = bbox

        # ── Coordinate conversion ──────────────────────────────────────────
        # The frontend sends coordinates in PDF *user space* (origin = bottom-
        # left, y increases upward — standard PDF coordinate system as returned
        # by PDF.js convertToPdfPoint).
        # PyMuPDF fitz.Rect uses origin = top-left, y increases downward.
        # Conversion:  fitz_y0 = page_height - (pdf_y + pdf_h)
        #              fitz_y1 = page_height - pdf_y
        page_h = page.rect.height
        rect = fitz.Rect(x, page_h - (y + h), x + w, page_h - y)

        # ── Step 1: White-fill ONLY the bbox ──────────────────────────────
        # draw_rect paints over just the selected area without touching any
        # other images or graphics on the page (unlike apply_redactions which
        # can remove ALL images whose bbox intersects the annotation).
        page.draw_rect(rect, color=None, fill=(1, 1, 1), overlay=True)

        # ── Step 2: Insert the AI-generated image on top ──────────────────
        page.insert_image(rect, stream=image_bytes, keep_proportion=False, overlay=True)

        # ── Serialise back to bytes ────────────────────────────────────────
        out = io.BytesIO()
        doc.save(out, deflate=True, garbage=4)
        doc.close()
        return out.getvalue()

    # ── Expanded background rendering ─────────────────────────────────────────

    def render_expanded_region(
        self,
        pdf_bytes: bytes,
        page_index: int,
        bbox: Tuple[float, float, float, float],
        expand_pt: float = 15.0,
        dpi: int = 72,
    ) -> Tuple[bytes, Tuple[float, float, float, float], Tuple[int, int]]:
        """
        Render a region slightly larger than *bbox* to capture surrounding
        paper texture for seamless compositing.

        Returns:
            (png_bytes, expanded_bbox, (pad_left_px, pad_top_px))

            expanded_bbox = (ex, ey, ew, eh) in PDF user-space points,
            clamped to page bounds.

            pad_left_px / pad_top_px = pixel offsets where the original
            bbox content starts inside the rendered image (at *dpi*).
        """
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        if page_index >= len(doc):
            raise ValueError(f"Page {page_index} out of range")

        page = doc[page_index]
        x, y, w, h = bbox
        page_h = page.rect.height
        page_w = page.rect.width

        # Expand, clamping to page bounds
        ex = max(0.0, x - expand_pt)
        ey = max(0.0, y - expand_pt)
        ex2 = min(page_w, x + w + expand_pt)
        ey2 = min(page_h, y + h + expand_pt)
        ew = ex2 - ex
        eh = ey2 - ey

        # Convert to fitz.Rect (top-left origin, y-down)
        clip = fitz.Rect(ex, page_h - ey2, ex2, page_h - ey)

        zoom = dpi / 72.0
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, clip=clip, alpha=False)
        doc.close()

        # Pixel offsets: where the original bbox starts within the pixmap
        pad_left_px = int(round((x - ex) * zoom))
        pad_top_px = int(round(((ey + eh) - (y + h)) * zoom))

        return (
            pix.tobytes("png"),
            (ex, ey, ew, eh),
            (pad_left_px, pad_top_px),
        )

    # ── Blended insert (seamless pipeline) ────────────────────────────────────

    def redact_and_insert_blended(
        self,
        pdf_bytes: bytes,
        page_index: int,
        bbox: Tuple[float, float, float, float],
        composited_image_bytes: bytes,
        expanded_bbox: Tuple[float, float, float, float],
    ) -> bytes:
        """
        Insert a pre-composited image that already contains the background
        texture and feathered edges.

        1. White-fills the original *bbox* to erase previous content.
        2. Overlays the composited image at the *expanded_bbox* region.

        Because the composited image's edges fade into the captured paper
        texture, the result looks seamless — no visible rectangular border.
        """
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        if page_index >= len(doc):
            raise ValueError(
                f"Page {page_index} out of range ({len(doc)} pages)"
            )

        page = doc[page_index]
        page_h = page.rect.height
        x, y, w, h = bbox
        ex, ey, ew, eh = expanded_bbox

        # 1. White-fill the original bbox to erase old content
        orig_rect = fitz.Rect(x, page_h - (y + h), x + w, page_h - y)
        page.draw_rect(orig_rect, color=None, fill=(1, 1, 1), overlay=True)

        # 2. Overlay the composited image at the expanded rect
        exp_rect = fitz.Rect(ex, page_h - (ey + eh), ex + ew, page_h - ey)
        page.insert_image(
            exp_rect,
            stream=composited_image_bytes,
            keep_proportion=False,
            overlay=True,
        )

        out = io.BytesIO()
        doc.save(out, deflate=True, garbage=4)
        doc.close()
        return out.getvalue()

    # ── Region crop (preview) ─────────────────────────────────────────────────
    def crop_region(
        self,
        pdf_bytes: bytes,
        page_index: int,
        bbox: Tuple[float, float, float, float],
        dpi: int = 144,
    ) -> bytes:
        """
        Renders the specified region of a PDF page to a PNG.
        Used both for preview and as the reference image passed to the AI
        so the model sees exactly what is currently in the selected area.

        Returns PNG bytes.
        """
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")

        if page_index >= len(doc):
            raise ValueError(f"Page {page_index} out of range")

        page = doc[page_index]
        x, y, w, h = bbox
        page_h = page.rect.height
        clip = fitz.Rect(x, page_h - (y + h), x + w, page_h - y)

        zoom = dpi / 72  # 72 pt = 1 inch
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, clip=clip, alpha=False)
        doc.close()
        return pix.tobytes("png")

    # ── Page dimensions helper ────────────────────────────────────────────────
    def get_page_dimensions(self, pdf_bytes: bytes) -> list[dict]:
        """Returns list of {page, width, height} in PDF points for all pages."""
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        dims = []
        for i, page in enumerate(doc):
            r = page.rect
            dims.append({"page": i, "width": r.width, "height": r.height})
        doc.close()
        return dims

    # ── Redact (color fill) ───────────────────────────────────────────────────
    def redact_region(
        self,
        pdf_bytes: bytes,
        page_index: int,
        bbox: Tuple[float, float, float, float],
        color: Tuple[float, float, float] = (0, 0, 0),
    ) -> bytes:
        """Fill the specified region with a solid color (default: black)."""
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        if page_index >= len(doc):
            raise ValueError(f"Page {page_index} out of range ({len(doc)} pages)")
        page = doc[page_index]
        x, y, w, h = bbox
        page_h = page.rect.height
        rect = fitz.Rect(x, page_h - (y + h), x + w, page_h - y)
        page.draw_rect(rect, color=None, fill=color, overlay=True)
        out = io.BytesIO()
        doc.save(out, deflate=True, garbage=4)
        doc.close()
        return out.getvalue()

    # ── Whiten ────────────────────────────────────────────────────────────────
    def whiten_region(
        self,
        pdf_bytes: bytes,
        page_index: int,
        bbox: Tuple[float, float, float, float],
    ) -> bytes:
        """Fill the specified region with white."""
        return self.redact_region(pdf_bytes, page_index, bbox, color=(1, 1, 1))

    # ── Add text in a box ─────────────────────────────────────────────────────
    def add_text_box(
        self,
        pdf_bytes: bytes,
        page_index: int,
        bbox: Tuple[float, float, float, float],
        text: str,
        font_size: float = 12,
        color: Tuple[float, float, float] = (0, 0, 0),
        font_name: str = "helv",
        align: int = 0,
    ) -> bytes:
        """Insert text within the specified rectangle."""
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        if page_index >= len(doc):
            raise ValueError(f"Page {page_index} out of range ({len(doc)} pages)")
        page = doc[page_index]
        x, y, w, h = bbox
        page_h = page.rect.height
        rect = fitz.Rect(x, page_h - (y + h), x + w, page_h - y)
        page.insert_textbox(
            rect, text, fontsize=font_size, color=color,
            fontname=font_name, align=align,
        )
        out = io.BytesIO()
        doc.save(out, deflate=True, garbage=4)
        doc.close()
        return out.getvalue()
