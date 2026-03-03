"""
AI Service – generates images from text prompts.

Supports:
  • Google Gemini (gemini-3.1-flash-image-preview) — recommended, GOOGLE_API_KEY
  • OpenAI DALL-E 3 / DALL-E 2  (OPENAI_API_KEY)
  • Stability AI (STABILITY_API_KEY)
  • Local stub (GENERATION_BACKEND=stub) for development without an API key

Set GENERATION_BACKEND in your .env to choose:
  gemini | openai | stability | stub
"""

from __future__ import annotations
import io
import os
import math
import asyncio
from typing import Optional

from PIL import Image, ImageDraw, ImageFont


class AIService:
    def __init__(self):
        self.backend = os.getenv("GENERATION_BACKEND", "openai").lower()

    # ── Public interface ──────────────────────────────────────────────────────
    async def generate(
        self,
        prompt: str,
        width: int,
        height: int,
        reference_image: Optional[bytes] = None,
        generation_type: str = "signature",
        model: Optional[str] = None,
    ) -> bytes:
        """
        Generate an image and return PNG bytes.

        Args:
            prompt:           Full text prompt.
            width / height:   Desired output dimensions in pixels.
            reference_image:  Optional reference image bytes.
            generation_type:  Hint for the generator.
            model:            Optional explicit model name that overrides
                              the GENERATION_BACKEND env var.
                              Gemini models: "gemini-*"
                              OpenAI models: "gpt-image-*", "dall-e-*", "chatgpt-*"
        """
        # Determine backend from explicit model name if provided
        if model:
            m = model.lower()
            if m.startswith("gemini"):
                backend = "gemini"
            elif any(m.startswith(p) for p in ("gpt-image", "dall-e", "chatgpt")):
                backend = "openai"
            else:
                backend = self.backend
        else:
            backend = self.backend

        if backend == "gemini":
            return await self._generate_gemini(prompt, width, height, reference_image)
        elif backend == "openai":
            return await self._generate_openai(prompt, width, height, reference_image, model=model)
        elif backend == "stability":
            return await self._generate_stability(prompt, width, height, reference_image)
        else:
            # Development stub – generates a plausible-looking placeholder
            return self._generate_stub(prompt, width, height, generation_type)

    # ── Public: OpenAI image-edit API ─────────────────────────────────────────
    async def edit_region(
        self,
        image_bytes: bytes,
        prompt: str,
        model: str = "gpt-image-1",
        quality: str = "auto",
        size: str = "1024x1024",
    ) -> bytes:
        """
        Edit an existing image region using OpenAI's /v1/images/edits endpoint.

        Supports GPT image models (gpt-image-1, gpt-image-1-mini, gpt-image-1.5,
        chatgpt-image-latest) via JSON body with base64 image_url, and dall-e-2
        via multipart form upload.

        Returns PNG bytes.
        """
        try:
            import httpx
            import base64
        except ImportError:
            raise RuntimeError("httpx package not installed: pip install httpx")

        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY environment variable not set")

        # Normalise input to PNG
        png_bytes = _to_png(image_bytes)

        if model == "dall-e-2":
            # dall-e-2 uses the classic multipart/form-data format
            return await self._edit_dalle2(png_bytes, prompt, api_key, size)

        # GPT image models accept a JSON body with base64 data URLs
        b64_image = base64.b64encode(png_bytes).decode()
        image_data_url = f"data:image/png;base64,{b64_image}"

        # Map arbitrary size to valid GPT image edit size
        valid_sizes = {"1024x1024", "1536x1024", "1024x1536", "auto"}
        if size not in valid_sizes:
            size = "1024x1024"

        payload: dict = {
            "images": [{"image_url": image_data_url}],
            "prompt": prompt,
            "model": model,
            "quality": quality,
            "size": size,
            "n": 1,
            "output_format": "png",
        }

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                "https://api.openai.com/v1/images/edits",
                headers=headers,
                json=payload,
            )
            if not resp.is_success:
                try:
                    err_body = resp.json()
                except Exception:
                    err_body = resp.text
                raise RuntimeError(
                    f"OpenAI image edit error {resp.status_code}: {err_body}"
                )
            data = resp.json()

        b64_data = data["data"][0]["b64_json"]
        return base64.b64decode(b64_data)

    async def _edit_dalle2(
        self,
        png_bytes: bytes,
        prompt: str,
        api_key: str,
        size: str,
    ) -> bytes:
        """dall-e-2 image edit via multipart form (classic OpenAI Python SDK)."""
        try:
            from openai import AsyncOpenAI
        except ImportError:
            raise RuntimeError("openai package not installed: pip install openai")

        import base64

        client = AsyncOpenAI(api_key=api_key)

        # dall-e-2 accepts 256x256, 512x512, 1024x1024
        if size not in {"256x256", "512x512", "1024x1024"}:
            size = "1024x1024"

        import io
        response = await client.images.edit(
            image=("region.png", io.BytesIO(png_bytes), "image/png"),
            prompt=prompt,
            size=size,  # type: ignore[arg-type]
            response_format="b64_json",
            n=1,
        )
        return base64.b64decode(response.data[0].b64_json)

    # ── Google Gemini ──────────────────────────────────────────────────────────
    async def _generate_gemini(
        self,
        prompt: str,
        width: int,
        height: int,
        reference_image: Optional[bytes],
    ) -> bytes:
        """
        Calls the Gemini multimodal image-generation endpoint.

        Model: gemini-3.1-flash-image-preview
        Endpoint: POST https://generativelanguage.googleapis.com/v1beta/models/
                       gemini-3.1-flash-image-preview:generateContent
        Auth: x-goog-api-key header

        Supports an optional reference image (inline_data, base64-encoded).
        Returns the first image part from the response as PNG bytes.
        """
        try:
            import httpx
        except ImportError:
            raise RuntimeError("httpx package not installed: pip install httpx")

        api_key = os.getenv("GOOGLE_API_KEY")
        if not api_key:
            raise RuntimeError("GOOGLE_API_KEY environment variable not set")

        import base64

        # ── Build parts ────────────────────────────────────────────────────
        parts: list[dict] = [
            {
                "text": (
                    f"{prompt}. "
                    "White background, isolated element, no borders, no shadows, "
                    "high resolution, clean and photorealistic."
                )
            }
        ]

        if reference_image:
            # Detect image media type (default jpeg)
            mime = _detect_mime(reference_image)
            parts.append(
                {
                    "inline_data": {
                        "mime_type": mime,
                        "data": base64.b64encode(reference_image).decode(),
                    }
                }
            )

        payload = {
            "contents": [{"parts": parts}],
        }

        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            "gemini-3.1-flash-image-preview:generateContent"
        )
        headers = {
            "x-goog-api-key": api_key,
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(url, headers=headers, json=payload)
            if not resp.is_success:
                # Surface the actual Gemini error body so it's visible in logs
                try:
                    err_body = resp.json()
                except Exception:
                    err_body = resp.text
                raise RuntimeError(
                    f"Gemini API error {resp.status_code}: {err_body}"
                )
            data = resp.json()

        # ── Extract image from response ─────────────────────────────────────
        candidates = data.get("candidates", [])
        if not candidates:
            raise RuntimeError(f"Gemini returned no candidates: {data}")

        parts_out = candidates[0].get("content", {}).get("parts", [])
        for part in parts_out:
            inline = part.get("inlineData")
            if inline and "data" in inline:
                img_bytes = base64.b64decode(inline["data"])
                # Normalise to PNG regardless of what Gemini returns
                return _to_png(img_bytes)

        raise RuntimeError(
            f"Gemini response contained no image part. Parts: {parts_out}"
        )

    # ── OpenAI DALL-E ─────────────────────────────────────────────────────────
    async def _generate_openai(
        self,
        prompt: str,
        width: int,
        height: int,
        reference_image: Optional[bytes],
        model: Optional[str] = None,
    ) -> bytes:
        try:
            from openai import AsyncOpenAI
        except ImportError:
            raise RuntimeError(
                "openai package not installed. Run: pip install openai"
            )

        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY environment variable not set")

        client = AsyncOpenAI(api_key=api_key)

        # DALL-E 3 only supports 1024×1024, 1024×1792, 1792×1024
        # We request the closest valid size and resize later
        dalle_size = _nearest_dalle3_size(width, height)

        enhanced_prompt = (
            f"{prompt}. White background, isolated element, "
            "no borders, no shadows, high resolution, photorealistic."
        )

        # Use the explicitly requested model when it's an OpenAI model,
        # otherwise fall back to dall-e-3 as the default generator.
        openai_model = model if model and not model.startswith("gemini") else "dall-e-3"
        response = await client.images.generate(
            model=openai_model,
            prompt=enhanced_prompt,
            size=dalle_size,
            quality="standard",
            response_format="b64_json",
            n=1,
        )

        import base64
        img_data = base64.b64decode(response.data[0].b64_json)
        return img_data

    # ── Stability AI ──────────────────────────────────────────────────────────
    async def _generate_stability(
        self,
        prompt: str,
        width: int,
        height: int,
        reference_image: Optional[bytes],
    ) -> bytes:
        try:
            import httpx
        except ImportError:
            raise RuntimeError("httpx package not installed: pip install httpx")

        api_key = os.getenv("STABILITY_API_KEY")
        if not api_key:
            raise RuntimeError("STABILITY_API_KEY environment variable not set")

        # Snap to multiples of 64, min 512
        w = max(512, _snap64(width))
        h = max(512, _snap64(height))

        payload = {
            "text_prompts": [{"text": prompt, "weight": 1.0}],
            "cfg_scale": 7,
            "height": h,
            "width": w,
            "samples": 1,
            "steps": 30,
        }
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                "https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image",
                headers=headers,
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()

        import base64
        return base64.b64decode(data["artifacts"][0]["base64"])

    # ── Stub (development / offline) ──────────────────────────────────────────
    def _generate_stub(
        self,
        prompt: str,
        width: int,
        height: int,
        generation_type: str,
    ) -> bytes:
        """
        Creates a realistic-looking placeholder:
        - signature type  → cursive squiggle lines on white
        - seal type       → circular shape with text
        - handwriting     → horizontal ruled lines with text
        """
        img = Image.new("RGBA", (width, height), (255, 255, 255, 0))
        draw = ImageDraw.Draw(img)

        if generation_type in ("signature", "handwriting"):
            _draw_fake_signature(draw, width, height)
        elif generation_type in ("seal", "stamp"):
            _draw_fake_seal(draw, width, height)
        else:
            _draw_fake_signature(draw, width, height)

        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _nearest_dalle3_size(w: int, h: int) -> str:
    """Map arbitrary dimensions to the nearest DALL-E 3 supported size."""
    ratio = w / h if h else 1
    if ratio > 1.2:
        return "1792x1024"
    elif ratio < 0.8:
        return "1024x1792"
    return "1024x1024"


def _snap64(n: int) -> int:
    """Round up to the nearest multiple of 64."""
    return math.ceil(n / 64) * 64


def _detect_mime(data: bytes) -> str:
    """Sniff the MIME type of raw image bytes."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return "image/jpeg"  # safe default


def _to_png(img_bytes: bytes) -> bytes:
    """Convert any Pillow-readable image bytes to PNG."""
    img = Image.open(io.BytesIO(img_bytes)).convert("RGBA")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _draw_fake_signature(draw: ImageDraw.ImageDraw, w: int, h: int):
    """Draw a squiggly cursive-style stub signature."""
    import random
    rng = random.Random(42)
    color = (20, 50, 180, 220)  # blue ink

    # Draw 2–3 looping strokes
    for stroke in range(rng.randint(2, 3)):
        points = []
        x = rng.randint(5, w // 4)
        y = h // 2 + rng.randint(-h // 6, h // 6)
        for _ in range(12):
            x += rng.randint(w // 16, w // 6)
            y += rng.randint(-h // 5, h // 5)
            x = min(x, w - 5)
            points.append((x, y))
        if len(points) >= 2:
            draw.line(points, fill=color, width=max(2, h // 20))

    # Underline
    uy = int(h * 0.72)
    draw.line([(w // 8, uy), (w - w // 8, uy)], fill=color, width=max(1, h // 30))


def _draw_fake_seal(draw: ImageDraw.ImageDraw, w: int, h: int):
    """Draw a circular stamp-style stub seal."""
    color = (180, 20, 20, 200)  # red ink
    pad = max(5, min(w, h) // 10)
    draw.ellipse(
        [(pad, pad), (w - pad, h - pad)],
        outline=color,
        width=max(2, min(w, h) // 20),
    )
    # Inner ring
    pad2 = pad + max(4, min(w, h) // 15)
    draw.ellipse(
        [(pad2, pad2), (w - pad2, h - pad2)],
        outline=color,
        width=max(1, min(w, h) // 40),
    )
    # Horizontal line through center
    cy = h // 2
    draw.line([(pad2 + 4, cy), (w - pad2 - 4, cy)], fill=color, width=max(1, h // 30))
