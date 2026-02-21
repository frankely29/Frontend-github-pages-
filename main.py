from fastapi import FastAPI, UploadFile, File
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
import os
import json
import traceback
import shutil

from build_hotspots import build_hotspots_json

app = FastAPI()

# -----------------------------
# Persist data on Railway Volume
# -----------------------------
# Railway volumes usually mount to /data (Linux container).
# If /data doesn't exist (local testing), fallback to ./data
DATA_DIR = Path("/data") if Path("/data").exists() else Path("data")
DATA_DIR.mkdir(parents=True, exist_ok=True)

OUT_PATH = DATA_DIR / "hotspots_20min.json"

# -----------------------------
# CORS so GitHub Pages can read Railway JSON
# -----------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # OK for now. Later you can lock to https://frankely29.github.io
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def root():
    return {
        "status": "ok",
        "data_dir": str(DATA_DIR.resolve()),
        "parquets": [p.name for p in DATA_DIR.glob("*.parquet")],
        "has_output": OUT_PATH.exists(),
        "output_mb": round(OUT_PATH.stat().st_size / 1024 / 1024, 2) if OUT_PATH.exists() else 0,
    }

@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    """
    Upload parquet files to the persistent volume.
    IMPORTANT: stream to disk (do NOT read entire file into memory).
    """
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    out_path = DATA_DIR / file.filename

    try:
        with out_path.open("wb") as f:
            shutil.copyfileobj(file.file, f)

        size_mb = round(out_path.stat().st_size / 1024 / 1024, 2)
        return {"saved": str(out_path), "size_mb": size_mb}
    except Exception as e:
        return JSONResponse(
            {"error": str(e), "trace": traceback.format_exc()},
            status_code=500
        )

@app.post("/generate")
def generate(
    bin_minutes: int = 20,
    good_n: int = 200,
    bad_n: int = 120,
    win_good_n: int = 80,
    win_bad_n: int = 40,
    min_trips_per_window: int = 10,
    simplify_meters: float = 25.0
):
    """
    Build hotspots_20min.json and save it into the persistent volume.
    """
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        parquets = sorted(DATA_DIR.glob("*.parquet"))

        if not parquets:
            return JSONResponse(
                {"error": "No .parquet files found in /data. Upload first via /upload."},
                status_code=400
            )

        build_hotspots_json(
            parquet_files=list(parquets),
            out_path=OUT_PATH,
            bin_minutes=bin_minutes,
            good_n=good_n,
            bad_n=bad_n,
            win_good_n=win_good_n,
            win_bad_n=win_bad_n,
            min_trips_per_window=min_trips_per_window,
            simplify_meters=simplify_meters,
        )

        return {
            "ok": True,
            "output": str(OUT_PATH),
            "size_mb": round(OUT_PATH.stat().st_size / 1024 / 1024, 2),
            "parquets_used": [p.name for p in parquets],
        }

    except Exception as e:
        return JSONResponse(
            {"error": str(e), "trace": traceback.format_exc()},
            status_code=500
        )

@app.get("/hotspots")
def hotspots():
    """
    IMPORTANT: return raw JSON (NOT attachment).
    This is what GitHub Pages app.js will fetch.
    """
    if not OUT_PATH.exists():
        return JSONResponse(
            {"error": "hotspots_20min.json not generated yet. Call /generate first."},
            status_code=404
        )
    try:
        data = json.loads(OUT_PATH.read_text(encoding="utf-8"))
        return JSONResponse(content=data)
    except Exception as e:
        return JSONResponse(
            {"error": f"Failed reading JSON: {e}", "trace": traceback.format_exc()},
            status_code=500
        )

@app.get("/download")
def download():
    """
    Optional: downloads file as an attachment (good for saving to phone/PC).
    NOTE: Safari sometimes blocks fetch() with attachments, so app.js will NOT use this.
    """
    if not OUT_PATH.exists():
        return JSONResponse(
            {"error": "hotspots_20min.json not generated yet. Call /generate first."},
            status_code=404
        )
    return FileResponse(
        str(OUT_PATH),
        media_type="application/json",
        filename="hotspots_20min.json"
    )
