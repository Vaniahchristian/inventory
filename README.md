# Inventory Import System

Next.js inventory app with PDF/CSV import, Supabase persistence, review queue, and optional OCR fallback.

## Run the app

```bash
npm install
npm run dev
```

App URL: [http://localhost:3000](http://localhost:3000)

## OCR backend (PaddleOCR + Python)

The app can optionally call a dedicated OCR backend when text parsing fails.

### Option A: Docker (recommended)

```bash
docker compose -f docker-compose.ocr.yml up --build
```

OCR service URL: `http://localhost:8001`

### Option B: Local Python

```bash
cd ocr_backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8001
```

## Environment variables

Add these to your `.env`:

```bash
NEXT_PUBLIC_OCR_PIPELINE_ENABLED=1
OCR_PIPELINE_ENABLED=1
OCR_BASE_URL=http://localhost:8001
OCR_API_KEY=
OCR_TIMEOUT_MS=120000
# OCR backend language model ("ch" recommended for mixed docs)
OCR_LANG=ch
```

## OCR integration flow

1. User imports PDF in `Products`.
2. `lib/export.ts` runs native PDF parser first.
3. If parser returns zero rows and OCR is enabled, frontend calls `/api/ocr-extract`.
4. `/api/ocr-extract` proxies to OCR backend `/extract`.
5. OCR backend returns normalized row objects compatible with import mapping.

## Current document pipeline

- `container_manifest` and `sales_order` type inference
- normalized storage in `documents`, `document_items`, `document_totals`, `document_payments`
- extraction observability in `extraction_runs`
- review queue UI at `/review-queue`

## Notes

- PaddleOCR CPU setup is heavier than Node-only runtime; use Docker for stable setup.
- OCR should be treated as fallback when native parser confidence is low or output is empty.
