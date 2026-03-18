#!/usr/bin/env python3
"""BunNotes Server — re-transcription + Obsidian vault save."""

import asyncio
import os
import re
import tempfile
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Request, Header
from fastapi.responses import JSONResponse
from faster_whisper import WhisperModel

from config import (
    WHISPER_MODEL_SIZE, WHISPER_DEVICE, WHISPER_COMPUTE_TYPE,
    OBSIDIAN_VAULT_PATH, OBSIDIAN_NOTES_FOLDER, HOST, PORT,
)

model: WhisperModel | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global model
    model = WhisperModel(WHISPER_MODEL_SIZE, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE_TYPE)
    yield

app = FastAPI(title="BunNotes Server", lifespan=lifespan)


@app.get("/api/health")
async def health():
    return JSONResponse({"status": "ok", "model": WHISPER_MODEL_SIZE, "device": WHISPER_DEVICE})


def do_transcribe(audio_bytes: bytes) -> dict:
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.write(audio_bytes)
    tmp.close()
    try:
        segments, info = model.transcribe(
            tmp.name, beam_size=5, language="en",
            vad_filter=True, vad_parameters=dict(min_silence_duration_ms=500),
        )
        return {"text": " ".join(seg.text.strip() for seg in segments).strip()}
    finally:
        os.unlink(tmp.name)


@app.post("/api/transcribe")
async def api_transcribe(
    audio: UploadFile = File(...),
    x_local_transcript: str = Header(default="", alias="X-Local-Transcript"),
):
    audio_bytes = await audio.read()
    loop = asyncio.get_event_loop()
    return JSONResponse(await loop.run_in_executor(None, do_transcribe, audio_bytes))


@app.post("/api/save")
async def api_save(request: Request):
    body = await request.json()
    text = body.get("text", "").strip()
    if not text:
        return JSONResponse({"error": "No text provided"}, status_code=400)

    created_at = body.get("created_at", None)
    now = datetime.now()
    if created_at:
        try:
            now = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            pass

    # Sanitize filename
    title = body.get("title", None)
    slug = re.sub(r'[^\w\-]', '', title or f"voice-note-{now.strftime('%Y%m%d-%H%M%S')}")
    filename = f"{slug}.md"

    folder = Path(OBSIDIAN_VAULT_PATH) / OBSIDIAN_NOTES_FOLDER
    folder.mkdir(parents=True, exist_ok=True)

    content = f"---\ndate: {now.strftime('%Y-%m-%d %H:%M')}\ntype: voice-note\ntags:\n  - voice-note\n  - whisper\n---\n\n{text}\n"
    (folder / filename).write_text(content, encoding="utf-8")
    return JSONResponse({"saved": True, "filename": filename})


@app.get("/api/notes")
async def api_notes():
    folder = Path(OBSIDIAN_VAULT_PATH) / OBSIDIAN_NOTES_FOLDER
    if not folder.exists():
        return JSONResponse({"notes": []})

    notes = []
    for fp in sorted(folder.glob("*.md"), key=lambda f: f.stat().st_mtime, reverse=True):
        try:
            raw = fp.read_text(encoding="utf-8")
            date_str = ""
            body = raw
            if raw.startswith("---"):
                parts = raw.split("---", 2)
                if len(parts) >= 3:
                    body = parts[2].strip()
                    for line in parts[1].splitlines():
                        if line.strip().startswith("date:"):
                            date_str = line.split(":", 1)[1].strip()
            preview = body[:200].replace("\n", " ").strip()
            title_words = body.strip().split()[:5]
            title = " ".join(title_words)
            if len(title) > 50:
                title = title[:50] + "..."
            notes.append({"filename": fp.name, "title": title, "preview": preview, "date": date_str})
        except Exception:
            continue
    return JSONResponse({"notes": notes})


@app.post("/api/delete")
async def api_delete(request: Request):
    body = await request.json()
    filename = body.get("filename", "")
    if not filename:
        return JSONResponse({"error": "No filename"}, status_code=400)
    folder = Path(OBSIDIAN_VAULT_PATH) / OBSIDIAN_NOTES_FOLDER
    filepath = folder / filename
    if filepath.exists() and filepath.resolve().parent == folder.resolve():
        filepath.unlink()
        return JSONResponse({"deleted": True})
    return JSONResponse({"deleted": False, "error": "Not found"}, status_code=404)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host=HOST, port=PORT, reload=False)
