"""
Image Service – compositing and post-processing of generated images.

Implements a multi-step blending pipeline for seamless PDF insertion:
  1. Soft white-background removal (gradient alpha instead of hard cutoff)
  2. Background tone matching (paper colour adaptation)
  3. Multiply blend mode (ink-on-paper simulation)
  4. Alpha mask feathering (soft edges — no hard rectangles)
  5. Gaussian noise addition (matches scan / print texture)
  6. Texture reconstruction via expanded-region compositing
"""

from __future__ import annotations

import io

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps


class ImageService:
    """Resizing, compositing, and cleanup for generated images."""

    # ── Basic resize (kept for preview / backward compat) ─────────────────────

    def resize_to_bbox(
        self,
        image_bytes: bytes,
        target_width: int,
        target_height: int,
        smart_crop: bool = True,
    ) -> bytes:
        """Resize image to exactly (target_width × target_height)."""
        img = Image.open(io.BytesIO(image_bytes)).convert("RGBA")

        if smart_crop:
            img = _autocrop_whitespace(img)

        resized = img.resize(
            (max(1, target_width), max(1, target_height)),
            resample=Image.LANCZOS,
        )

        buf = io.BytesIO()
        resized.save(buf, format="PNG")
        return buf.getvalue()

    # ── Full compositing pipeline ─────────────────────────────────────────────

    def prepare_for_insertion(
        self,
        generated_img_bytes: bytes,
        background_patch_bytes: bytes,
        target_width: int,
        target_height: int,
        pad_left: int = 15,
        pad_top: int = 15,
        feather_radius: int = 10,
        noise_amount: float = 0.012,
        bg_blend_factor: float = 0.10,
        use_multiply: bool = True,
    ) -> bytes:
        """
        Seamless compositing pipeline.

        Takes the raw AI-generated image and a rendered background patch
        (slightly larger than the target area) and produces a flattened
        image that blends invisibly into the PDF page.

        Args:
            generated_img_bytes:    PNG of the AI-generated content.
            background_patch_bytes: PNG of the expanded region rendered
                                    from the original PDF page.
            target_width:           Width of the original bbox in px
                                    (= PDF pts at 72 dpi).
            target_height:          Height of the original bbox in px.
            pad_left:               Pixel offset where the target area
                                    starts inside the background patch.
            pad_top:                Pixel offset from the top.
            feather_radius:         Gaussian blur radius for soft edges.
            noise_amount:           Gaussian noise σ as fraction of 255.
            bg_blend_factor:        Tone-match intensity (0–0.3).
            use_multiply:           True → multiply blend (best for ink /
                                    stamps); False → normal alpha composite.

        Returns:
            PNG bytes at the full background-patch size, ready for
            direct overlay into the PDF at the expanded rect.
        """
        # ── Load images ──────────────────────────────────────────────────────
        gen_img = Image.open(io.BytesIO(generated_img_bytes)).convert("RGBA")
        bg_img = Image.open(io.BytesIO(background_patch_bytes)).convert("RGB")

        tw = max(1, target_width)
        th = max(1, target_height)
        gen_img = gen_img.resize((tw, th), Image.LANCZOS)
        full_w, full_h = bg_img.size

        # ── 0. Erase old content inside the target area ──────────────────────
        # White-fill the inner bbox region of the background patch so any
        # existing stamp / signature / text is removed before compositing.
        # The surrounding band keeps the real paper texture for seamless
        # feathered edges.
        bg_arr = np.array(bg_img, dtype=np.float32)
        x0, y0 = pad_left, pad_top
        x1 = min(pad_left + tw, full_w)
        y1 = min(pad_top + th, full_h)
        bg_arr[y0:y1, x0:x1] = 255.0   # white out old content
        bg_img = Image.fromarray(bg_arr.astype(np.uint8), "RGB")

        # ── 1. Soft background removal ───────────────────────────────────────
        gen_img = _soft_remove_white_bg(gen_img, threshold=220, softness=25)

        # ── 2. Background tone matching ──────────────────────────────────────
        # Sample tone from the surrounding border of the patch (not the
        # white-filled center) so we match paper colour correctly.
        border_mask = np.ones((full_h, full_w), dtype=bool)
        border_mask[y0:y1, x0:x1] = False
        bg_full_arr = np.array(bg_img, dtype=np.float32)
        if border_mask.any():
            avg_border = bg_full_arr[border_mask].mean(axis=0)  # (3,)
        else:
            avg_border = np.array([255.0, 255.0, 255.0])
        bg_center = Image.fromarray(
            np.full((th, tw, 3), avg_border, dtype=np.uint8), "RGB"
        )
        if bg_center.size != (tw, th):
            bg_center = bg_center.resize((tw, th), Image.LANCZOS)

        gen_img = _match_background_tone(gen_img, bg_center, factor=bg_blend_factor)

        # ── 3. Blend mode ────────────────────────────────────────────────────
        gen_rgb = gen_img.convert("RGB")
        gen_alpha = gen_img.split()[3]

        if use_multiply:
            blended_rgb = _multiply_blend(gen_rgb, bg_center)
        else:
            blended_rgb = gen_rgb

        # ── 4. Feathered alpha mask ──────────────────────────────────────────
        feather_mask = _create_feathered_mask(tw, th, feather_radius)
        final_alpha = ImageChops.multiply(gen_alpha, feather_mask)

        # ── 5. Compose onto full background canvas ───────────────────────────
        # bg_img already has the inner area white-filled (step 0), so the
        # final image is clean beneath the generated content.
        result = bg_img.copy().convert("RGBA")
        overlay = Image.new("RGBA", (tw, th))
        overlay.paste(blended_rgb, (0, 0))
        overlay.putalpha(final_alpha)
        result.paste(overlay, (pad_left, pad_top), overlay)

        # ── 6. Add subtle noise ──────────────────────────────────────────────
        result = _add_gaussian_noise(result, amount=noise_amount)

        # ── 7. Flatten to opaque RGB for PDF insertion ───────────────────────
        flat = Image.new("RGB", result.size, (255, 255, 255))
        flat.paste(result, mask=result.split()[3])

        buf = io.BytesIO()
        flat.save(buf, format="PNG", optimize=True)
        return buf.getvalue()

    # ── Legacy helper ─────────────────────────────────────────────────────────

    def remove_background(self, image_bytes: bytes) -> bytes:
        """Naive white-background removal (hard cutoff)."""
        img = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
        data = img.getdata()
        threshold = 230
        new_data = []
        for r, g, b, a in data:
            if r > threshold and g > threshold and b > threshold:
                new_data.append((255, 255, 255, 0))
            else:
                new_data.append((r, g, b, a))
        img.putdata(new_data)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()


# ══════════════════════════════════════════════════════════════════════════════
# Internal helpers
# ══════════════════════════════════════════════════════════════════════════════


def _autocrop_whitespace(img: Image.Image, threshold: int = 235) -> Image.Image:
    """Crop away near-white borders, preserving drawn content."""
    gray = img.convert("L")
    inverted = ImageOps.invert(gray)
    bbox = inverted.getbbox()
    if bbox is None:
        return img
    pad = 4
    x0, y0, x1, y1 = bbox
    x0 = max(0, x0 - pad)
    y0 = max(0, y0 - pad)
    x1 = min(img.width, x1 + pad)
    y1 = min(img.height, y1 + pad)
    return img.crop((x0, y0, x1, y1))


def _soft_remove_white_bg(
    img: Image.Image,
    threshold: int = 220,
    softness: int = 25,
) -> Image.Image:
    """
    Gradient-based white background removal.

    Instead of a hard cutoff, pixels between *threshold* and
    *threshold + softness* become partially transparent — creating
    a smooth transition that avoids aliased / harsh edges.
    """
    arr = np.array(img, dtype=np.float32)  # (H, W, 4) RGBA
    rgb = arr[:, :, :3]
    alpha = arr[:, :, 3]

    luminance = rgb.mean(axis=2)  # per-pixel brightness

    # Ramp: fully opaque at threshold → fully transparent at threshold+softness
    transparency = np.clip((luminance - threshold) / max(softness, 1), 0.0, 1.0)
    arr[:, :, 3] = alpha * (1.0 - transparency)

    return Image.fromarray(arr.astype(np.uint8), "RGBA")


def _create_feathered_mask(
    width: int,
    height: int,
    radius: int = 10,
) -> Image.Image:
    """
    L-mode mask: 255 in center, fading to 0 over *radius* pixels
    at every edge via Gaussian blur.
    """
    mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask)
    inset = radius
    if width > 2 * inset and height > 2 * inset:
        draw.rectangle(
            [inset, inset, width - 1 - inset, height - 1 - inset],
            fill=255,
        )
    else:
        # Very small region — just fill fully
        draw.rectangle([0, 0, width - 1, height - 1], fill=255)

    mask = mask.filter(ImageFilter.GaussianBlur(radius=max(radius * 0.6, 1)))
    return mask


def _multiply_blend(fg: Image.Image, bg: Image.Image) -> Image.Image:
    """
    Multiply blend: ``result = (fg × bg) / 255``.

    Dark pixels from *fg* darken *bg*; white pixels leave *bg*
    unchanged.  Mimics ink / stamp / printing on textured paper.
    """
    fg_arr = np.array(fg, dtype=np.float32)
    bg_arr = np.array(bg, dtype=np.float32)
    out = (fg_arr * bg_arr) / 255.0
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def _match_background_tone(
    img: Image.Image,
    bg_patch: Image.Image,
    factor: float = 0.10,
) -> Image.Image:
    """
    Slightly tint the generated image toward the average background
    colour so it doesn't look too *clean* against scanned paper.
    """
    bg_arr = np.array(bg_patch.convert("RGB"), dtype=np.float32)
    avg_color = bg_arr.mean(axis=(0, 1))  # shape (3,)

    img_arr = np.array(img, dtype=np.float32)  # RGBA
    rgb = img_arr[:, :, :3]
    rgb = rgb * (1.0 - factor) + avg_color * factor
    img_arr[:, :, :3] = np.clip(rgb, 0, 255)

    return Image.fromarray(img_arr.astype(np.uint8), img.mode)


def _add_gaussian_noise(
    img: Image.Image,
    amount: float = 0.012,
) -> Image.Image:
    """
    Sprinkle subtle Gaussian noise on RGB channels so the image
    matches typical scan / print grain.  *amount* is σ / 255.
    """
    arr = np.array(img, dtype=np.float32)
    sigma = amount * 255.0
    noise = np.random.normal(0.0, sigma, arr[:, :, :3].shape).astype(np.float32)
    arr[:, :, :3] = np.clip(arr[:, :, :3] + noise, 0, 255)
    return Image.fromarray(arr.astype(np.uint8), img.mode)
