# ifakepdf

AI-powered PDF editor — draw a bounding box on any region, generate a
signature / seal / handwriting with AI, and insert it seamlessly into the PDF.

```
User draws bbox  →  Backend erases region  →  AI generates image
                 →  Image resized to bbox  →  Inserted into PDF
                 →  Modified PDF returned to browser
```

---

## Stack

| Layer     | Tech                                        |
|-----------|---------------------------------------------|
| Frontend  | Next.js 14 (App Router) · TypeScript · Tailwind CSS · PDF.js |
| Backend   | Python · FastAPI · PyMuPDF (fitz) · Pillow  |
| AI        | OpenAI DALL-E 3 (default) · Stability AI · Stub (dev) |

---

## Quick Start

### 1 — Clone & setup

```bash
git clone <repo>
cd ifakepdf
chmod +x setup.sh start.sh
./setup.sh          # creates venv, installs packages, copies .env
```

### 2 — Configure AI backend

Edit `backend/.env`:

```env
# Google Gemini (recommended – supports reference image)
GENERATION_BACKEND=gemini
GOOGLE_API_KEY=AIza...

# Or OpenAI DALL-E 3:
# GENERATION_BACKEND=openai
# OPENAI_API_KEY=sk-...

# Or no API key (dev placeholder):
# GENERATION_BACKEND=stub
```

### 3 — Run

```bash
./start.sh
```

- Frontend: http://localhost:3000
- Backend API: http://localhost:8000
- API Docs: http://localhost:8000/docs

---

## Project Structure

```
ifakepdf/
├── backend/
│   ├── main.py                  # FastAPI app + endpoints
│   ├── services/
│   │   ├── pdf_service.py       # PyMuPDF: redact + insert
│   │   ├── ai_service.py        # DALL-E / Stability / Stub
│   │   └── image_service.py     # resize, autocrop, bg removal
│   ├── requirements.txt
│   └── .env.example
│
├── frontend/
│   ├── app/
│   │   ├── page.tsx             # Main editor page
│   │   └── globals.css
│   ├── components/
│   │   ├── PDFViewer.tsx        # PDF.js render + bbox canvas
│   │   ├── EditPanel.tsx        # Controls + generation trigger
│   │   └── FileDropzone.tsx     # PDF upload widget
│   ├── lib/
│   │   └── api.ts               # Backend API client
│   └── .env.local
│
├── setup.sh
├── start.sh
└── README.md
```

---

## API

### `POST /api/process`

| Field            | Type   | Description                                    |
|------------------|--------|------------------------------------------------|
| `pdf`            | File   | Original PDF                                   |
| `page`           | int    | 0-based page index                             |
| `x`, `y`         | float  | Top-left of bbox in PDF points                 |
| `width`, `height`| float  | Bbox dimensions in PDF points                  |
| `prompt`         | string | Text prompt for generation                     |
| `generation_type`| string | `signature \| handwriting \| seal \| stamp \| custom` |
| `reference_image`| File?  | Optional reference image                       |

Returns the modified PDF as `application/pdf`.

### `POST /api/preview-region`

Returns a PNG crop of the selected region (for inspection).

---

## AI Backends

| Value       | Description                                | Needs                  |
|-------------|--------------------------------------------|-----------------------  |
| `gemini`    | Gemini 3.1 Flash image generation (default)| `GOOGLE_API_KEY`       |
| `openai`    | DALL-E 3 via OpenAI API                    | `OPENAI_API_KEY`       |
| `stability` | Stable Diffusion XL via Stability AI API   | `STABILITY_API_KEY`    |
| `stub`      | Generates a local placeholder (dev mode)   | Nothing                |

Set `GENERATION_BACKEND` in `backend/.env`.

The Gemini backend accepts an **optional reference image** alongside the prompt — useful for style-matching an existing signature or seal.

---

## Production Notes

- For best signature quality, use `openai` backend (DALL-E 3).
- To remove image backgrounds cleanly, install `rembg` and call
  `image_service.remove_background()` before insertion.
- Deploy the backend on any Python-capable server (Railway, Fly.io, etc.)
  and set `NEXT_PUBLIC_API_URL` in the frontend.
