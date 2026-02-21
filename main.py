from fastapi import FastAPI, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.gzip import GZipMiddleware
from pathlib import Path
import traceback
import os
import time

from build_hotspots import build_hotspots_json

app = FastAPI()

# ✅ GZIP compress responses larger than 1 KB
app.add_middleware(GZipMiddleware, minimum_size=1024)

# IMPORTANT: If you're using a Railway Volume mounted at /data,
# write there so it's persistent.
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
OUT_PATH = Path(os.environ.get("OUT_PATH", "/data/hotspots_20min.json"))

@app.get("/")
def root():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    parquets = sorted([p.name for p in DATA_DIR.glob("*.parquet")])
    has_output = OUT_PATH.exists()
    out_mb = round(OUT_PATH.stat().st_size / 1024 / 1024, 2) if has_output else 0
    return {
        "status": "ok",
        "data_dir": str(DATA_DIR),
        "parquets": parquets,
        "has_output": has_output,
        "output_mb": out_mb
    }

@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    out_path = DATA_DIR / file.filename
    content = await file.read()
    out_path.write_bytes(content)
    return {"saved": str(out_path), "size_mb": round(len(content)/1024/1024, 2)}

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
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        parquets = list(DATA_DIR.glob("*.parquet"))
        if not parquets:
            return JSONResponse({"error": "No .parquet files found in /data. Upload first via /upload."}, status_code=400)

        # write output to the volume (/data) so it persists
        t0 = time.time()
        build_hotspots_json(
            parquet_files=parquets,
            out_path=OUT_PATH,
            bin_minutes=bin_minutes,
            good_n=good_n,
            bad_n=bad_n,
            win_good_n=win_good_n,
            win_bad_n=win_bad_n,
            min_trips_per_window=min_trips_per_window,
            simplify_meters=simplify_meters,
        )
        sec = round(time.time() - t0, 2)
        return {"ok": True, "output": str(OUT_PATH), "size_mb": round(OUT_PATH.stat().st_size/1024/1024, 2), "seconds": sec}
    except Exception as e:
        return JSONResponse(
            {"error": str(e), "trace": traceback.format_exc()},
            status_code=500
        )

@app.get("/download")
def download():
    if not OUT_PATH.exists():
        return JSONResponse({"error": "hotspots_20min.json not generated yet. Call /generate first."}, status_code=404)

    # ✅ Cache for 5 minutes so refreshing is instant-ish
    headers = {
        "Cache-Control": "public, max-age=300"
    }

    # ✅ This will be automatically gzip-compressed by GZipMiddleware
    return FileResponse(
        str(OUT_PATH),
        media_type="application/json",
        filename="hotspots_20min.json",
        headers=headers
    )