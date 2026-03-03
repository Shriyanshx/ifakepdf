"""
ifakepdf – Backend API
FastAPI server that handles PDF region erasing and AI image insertion.
"""

from fastapi import Cookie, Depends, FastAPI, Request, Response, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn
import tempfile
import os
from typing import Optional

from services.pdf_service import PDFService
from services.ai_service import AIService
from services.image_service import ImageService
from services.rate_limiter import enforce_rate_limit, get_status

app = FastAPI(title="ifakepdf API", version="1.0.0")

# ── CORS ─────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "https://ifakepdf-frontend.netlify.app",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

pdf_service = PDFService()
ai_service = AIService()
image_service = ImageService()


@app.get("/health")
async def health():
    return {"status": "ok", "service": "ifakepdf"}


@app.get("/api/rate-limit-status")
async def rate_limit_status(
    request: Request,
    response: Response,
    rl_id: Optional[str] = Cookie(default=None),
):
    """Returns the caller's remaining generation quota for the current 24-hour window."""
    return get_status(request, response, rl_id)


@app.post("/api/process")
async def process_pdf(
    _rl: dict = Depends(enforce_rate_limit),
    pdf: UploadFile = File(..., description="Original PDF file"),
    page: int = Form(..., description="0-based page index"),
    x: float = Form(..., description="Bounding box X (PDF pts)"),
    y: float = Form(..., description="Bounding box Y (PDF pts)"),
    width: float = Form(..., description="Bounding box width (PDF pts)"),
    height: float = Form(..., description="Bounding box height (PDF pts)"),
    prompt: Optional[str] = Form(
        "handwritten signature in blue ink",
        description="Text prompt for AI generation",
    ),
    generation_type: str = Form(
        "signature",
        description="One of: signature | handwriting | seal | stamp | custom",
    ),
    reference_image: Optional[UploadFile] = File(
        None, description="Optional reference image to guide generation"
    ),
    feather_radius: int = Form(
        4, description="Edge feather radius in px (0=hard, 1-10=soft)",
    ),
    noise_amount: float = Form(
        0.012, description="Gaussian noise σ as fraction of 255 (0=none)",
    ),
    edge_expand: float = Form(
        15.0, description="Expansion padding in PDF pts for edge blending",
    ),
    ai_model: Optional[str] = Form(None, description="Explicit AI model override"),
):
    """
    Core endpoint:
    1. Receive PDF + bounding box + prompt
    2. Erase the region from the PDF (white-fill redaction)
    3. Generate AI image matching the bounding box dimensions
    4. Composite the image into the PDF at the exact region
    5. Return the modified PDF as bytes
    """
    # ── Validate bbox ──────────────────────────────────────────────────────
    if width <= 0 or height <= 0:
        raise HTTPException(status_code=400, detail="Width and height must be positive")

    # ── Read uploads into memory ───────────────────────────────────────────
    pdf_bytes = await pdf.read()
    user_ref_bytes = await reference_image.read() if reference_image else None

    # Expansion padding (PDF points) for seamless edge blending
    EXPAND_PT = max(0.0, edge_expand)

    try:
        bbox = (x, y, width, height)

        # ── Step 1: Crop the selected region from the PDF ──────────────────
        # Always send the current content of the bbox to the AI so the model
        # can see what it is replacing / editing in context.
        region_crop = pdf_service.crop_region(pdf_bytes, page, bbox)

        # User-uploaded reference takes priority; region crop is the fallback.
        ref_bytes = user_ref_bytes if user_ref_bytes else region_crop

        # ── Step 2: Build the generation prompt ────────────────────────────
        full_prompt = _build_prompt(prompt, generation_type, width, height)

        # ── Step 3: Generate AI image sized to the bbox ────────────────────
        # Generate at 2× for quality; compositing will resize to fit.
        gen_width = max(int(width * 2), 64)
        gen_height = max(int(height * 2), 64)
        img_bytes = await ai_service.generate(
            prompt=full_prompt,
            width=gen_width,
            height=gen_height,
            reference_image=ref_bytes,
            generation_type=generation_type,
            model=ai_model or None,
        )
        _save_debug_image(img_bytes, tag="process")

        # ── Step 4: Render expanded background for compositing ─────────────
        bg_bytes, expanded_bbox, (pad_left, pad_top) = (
            pdf_service.render_expanded_region(
                pdf_bytes, page, bbox, expand_pt=EXPAND_PT, dpi=72,
            )
        )

        # ── Step 5: Composite with seamless blending ───────────────────────
        use_multiply = generation_type in ("signature", "handwriting", "seal", "stamp")
        composited = image_service.prepare_for_insertion(
            generated_img_bytes=img_bytes,
            background_patch_bytes=bg_bytes,
            target_width=int(width),
            target_height=int(height),
            pad_left=pad_left,
            pad_top=pad_top,
            feather_radius=feather_radius,
            noise_amount=noise_amount,
            use_multiply=use_multiply,
        )

        # ── Step 6: Insert composited result into PDF ──────────────────────
        result_pdf = pdf_service.redact_and_insert_blended(
            pdf_bytes=pdf_bytes,
            page_index=page,
            bbox=bbox,
            composited_image_bytes=composited,
            expanded_bbox=expanded_bbox,
        )

    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    return Response(
        content=result_pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": "attachment; filename=modified.pdf"},
    )


@app.post("/api/preview-region")
async def preview_region(
    pdf: UploadFile = File(...),
    page: int = Form(...),
    x: float = Form(...),
    y: float = Form(...),
    width: float = Form(...),
    height: float = Form(...),
):
    """
    Returns a PNG crop of the selected region for user inspection.
    """
    pdf_bytes = await pdf.read()
    try:
        png_bytes = pdf_service.crop_region(pdf_bytes, page, (x, y, width, height))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    return Response(content=png_bytes, media_type="image/png")


@app.post("/api/generate-image")
async def generate_image(
    _rl: dict = Depends(enforce_rate_limit),
    pdf: UploadFile = File(..., description="PDF to crop region from"),
    page: int = Form(...),
    x: float = Form(...),
    y: float = Form(...),
    width: float = Form(...),
    height: float = Form(...),
    prompt: Optional[str] = Form("handwritten signature in blue ink"),
    generation_type: str = Form("signature"),
    reference_image: Optional[UploadFile] = File(None),
    # ── New: model selection & edit-mode ───────────────────────────────────
    ai_model: Optional[str] = Form(None, description="OpenAI model for generation/editing"),
    use_edit: bool = Form(False, description="Use OpenAI image-edit API instead of generate"),
    edit_quality: str = Form("auto", description="Quality for GPT image edit (auto/low/medium/high)"),
):
    """
    Step 1 of the two-step flow:
    Generates (or edits) an image and returns it as PNG WITHOUT modifying the PDF.

    When use_edit=true, calls the OpenAI /v1/images/edits endpoint using the
    selected region as the source image and the prompt as the edit instruction.
    The frontend shows this as a draggable preview overlay.
    """
    if width <= 0 or height <= 0:
        raise HTTPException(status_code=400, detail="Width and height must be positive")

    pdf_bytes = await pdf.read()
    user_ref_bytes = await reference_image.read() if reference_image else None

    try:
        bbox = (x, y, width, height)

        # Crop the selected region (used both as AI context and as edit source)
        region_crop = pdf_service.crop_region(pdf_bytes, page, bbox)
        ref_bytes = user_ref_bytes if user_ref_bytes else region_crop

        full_prompt = _build_prompt(prompt, generation_type, width, height)

        if use_edit:
            # ── OpenAI image-edit path ─────────────────────────────────────
            model = ai_model or "gpt-image-1"
            # Pick the nearest standard size for best output quality
            edit_size = _nearest_edit_size(int(width), int(height))
            img_bytes = await ai_service.edit_region(
                image_bytes=region_crop,
                prompt=full_prompt,
                model=model,
                quality=edit_quality,
                size=edit_size,
            )
        else:
            # ── Standard generation path ───────────────────────────────────
            gen_width = max(int(width * 2), 64)
            gen_height = max(int(height * 2), 64)
            img_bytes = await ai_service.generate(
                prompt=full_prompt,
                width=gen_width,
                height=gen_height,
                reference_image=ref_bytes,
                generation_type=generation_type,
                model=ai_model or None,
            )

        # Return at the exact bbox size so the frontend can overlay it 1:1
        img_bytes = image_service.resize_to_bbox(img_bytes, int(width), int(height))
        _save_debug_image(img_bytes, tag="generate_image")

    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    return Response(
        content=img_bytes,
        media_type="image/png",
        headers={"Content-Disposition": "inline; filename=generated.png"},
    )


@app.post("/api/insert-image")
async def insert_image_endpoint(
    pdf: UploadFile = File(..., description="Original PDF"),
    page: int = Form(...),
    x: float = Form(...),
    y: float = Form(...),
    width: float = Form(...),
    height: float = Form(...),
    image: UploadFile = File(..., description="Image to insert (PNG/JPEG)"),
    feather_radius: int = Form(
        4, description="Edge feather radius in px (0=hard, 1-10=soft)",
    ),
    noise_amount: float = Form(
        0.012, description="Gaussian noise σ as fraction of 255 (0=none)",
    ),
    edge_expand: float = Form(
        15.0, description="Expansion padding in PDF pts for edge blending",
    ),
):
    """
    Step 2 of the two-step flow:
    Inserts a pre-generated image at the given position (which may have been
    adjusted by the user dragging the preview overlay) and returns the PDF.
    """
    if width <= 0 or height <= 0:
        raise HTTPException(status_code=400, detail="Width and height must be positive")

    # Expansion padding (PDF points) for seamless edge blending
    EXPAND_PT = max(0.0, edge_expand)

    pdf_bytes = await pdf.read()
    img_bytes = await image.read()

    try:
        bbox = (x, y, width, height)

        # ── Render expanded background for compositing ─────────────────────
        bg_bytes, expanded_bbox, (pad_left, pad_top) = (
            pdf_service.render_expanded_region(
                pdf_bytes, page, bbox, expand_pt=EXPAND_PT, dpi=72,
            )
        )

        # ── Composite with seamless blending ───────────────────────────────
        composited = image_service.prepare_for_insertion(
            generated_img_bytes=img_bytes,
            background_patch_bytes=bg_bytes,
            target_width=int(width),
            target_height=int(height),
            pad_left=pad_left,
            pad_top=pad_top,
            feather_radius=feather_radius,
            noise_amount=noise_amount,
        )

        # ── Insert composited result into PDF ──────────────────────────────
        result_pdf = pdf_service.redact_and_insert_blended(
            pdf_bytes=pdf_bytes,
            page_index=page,
            bbox=bbox,
            composited_image_bytes=composited,
            expanded_bbox=expanded_bbox,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    return Response(
        content=result_pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": "attachment; filename=modified.pdf"},
    )


# ── New editing endpoints ──────────────────────────────────────────────────


@app.post("/api/redact-region")
async def redact_region_endpoint(
    pdf: UploadFile = File(...),
    page: int = Form(...),
    x: float = Form(...),
    y: float = Form(...),
    width: float = Form(...),
    height: float = Form(...),
    color: str = Form("#000000", description="Hex color for redaction fill"),
):
    """Apply a colored fill over the specified region (redaction)."""
    if width <= 0 or height <= 0:
        raise HTTPException(status_code=400, detail="Width and height must be positive")
    pdf_bytes = await pdf.read()
    rgb = _hex_to_rgb(color)
    try:
        result_pdf = pdf_service.redact_region(
            pdf_bytes, page, (x, y, width, height), color=rgb,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return Response(
        content=result_pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": "attachment; filename=modified.pdf"},
    )


@app.post("/api/whiten-region")
async def whiten_region_endpoint(
    pdf: UploadFile = File(...),
    page: int = Form(...),
    x: float = Form(...),
    y: float = Form(...),
    width: float = Form(...),
    height: float = Form(...),
):
    """White-fill the specified region."""
    if width <= 0 or height <= 0:
        raise HTTPException(status_code=400, detail="Width and height must be positive")
    pdf_bytes = await pdf.read()
    try:
        result_pdf = pdf_service.whiten_region(pdf_bytes, page, (x, y, width, height))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return Response(
        content=result_pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": "attachment; filename=modified.pdf"},
    )


@app.post("/api/add-text")
async def add_text_endpoint(
    pdf: UploadFile = File(...),
    page: int = Form(...),
    x: float = Form(...),
    y: float = Form(...),
    width: float = Form(...),
    height: float = Form(...),
    text: str = Form(..., description="Text content to insert"),
    font_size: float = Form(12),
    font_color: str = Form("#000000"),
    font_family: str = Form("helv"),
    align: int = Form(0, description="0=left, 1=center, 2=right, 3=justify"),
):
    """Insert text within the specified rectangle."""
    if width <= 0 or height <= 0:
        raise HTTPException(status_code=400, detail="Width and height must be positive")
    pdf_bytes = await pdf.read()
    rgb = _hex_to_rgb(font_color)
    try:
        result_pdf = pdf_service.add_text_box(
            pdf_bytes, page, (x, y, width, height), text,
            font_size=font_size, color=rgb, font_name=font_family, align=align,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return Response(
        content=result_pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": "attachment; filename=modified.pdf"},
    )


def _hex_to_rgb(hex_color: str) -> tuple:
    """Convert #RRGGBB to (r, g, b) with values 0.0-1.0."""
    hex_color = hex_color.lstrip("#")
    if len(hex_color) != 6:
        return (0.0, 0.0, 0.0)
    r = int(hex_color[0:2], 16) / 255.0
    g = int(hex_color[2:4], 16) / 255.0
    b = int(hex_color[4:6], 16) / 255.0
    return (r, g, b)


def _build_prompt(
    user_prompt: Optional[str],
    generation_type: str,
    width: float = 0,
    height: float = 0,
) -> str:
    """
    Build the final prompt sent to the AI.
    Appends the selection dimensions so the model knows the exact
    pixel area it needs to fill.
    """
    base = user_prompt or ""
    if width > 0 and height > 0:
        dim_hint = (
            f" The output image must fill exactly {round(width)}x{round(height)} points "
            f"({'landscape' if width > height else 'portrait' if height > width else 'square'} orientation). "
            "Make sure the content fits naturally within this area without cropping."
        )
        return base + dim_hint
    return base


def _nearest_edit_size(w: int, h: int) -> str:
    """Map arbitrary bbox dimensions to the nearest valid GPT image edit size."""
    ratio = w / h if h else 1
    if ratio > 1.2:
        return "1536x1024"   # landscape
    elif ratio < 0.8:
        return "1024x1536"   # portrait
    return "1024x1024"       # square


# ── DEBUG: save generated images locally ─────────────────────────────────────
_DEBUG_DIR = os.path.join(os.path.dirname(__file__), "debug_images")

def _save_debug_image(img_bytes: bytes, tag: str = "gen") -> str:
    """
    Save *img_bytes* to <backend>/debug_images/ with a timestamp-based name.
    Prints the absolute path so it's visible in the server logs.
    Returns the path string.
    """
    import datetime
    os.makedirs(_DEBUG_DIR, exist_ok=True)
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    path = os.path.join(_DEBUG_DIR, f"{tag}_{ts}.png")
    with open(path, "wb") as f:
        f.write(img_bytes)
    print(f"[DEBUG] AI image saved → {path}", flush=True)
    return path


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
