from fastapi import FastAPI, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
import shutil
import traceback

from build_hotspots import build_hotspots_json

app = FastAPI()

# IMPORTANT: persist everything on the Railway Volume
# You mounted the volume to /data, so we use it.
DATA_DIR = Path("/data")
OUT_PATH = DATA_DIR / "hotspots_20min.json"

# Allow GitHub Pages to fetch from Railway
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # you can tighten later to your github domain
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
        "output_mb": out_mb,
    }

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    """
    Stream upload to disk (does NOT load 500MB into RAM).
    """
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    out_path = DATA_DIR / file.filename

    try:
        with out_path.open("wb") as f:
            shutil.copyfileobj(file.file, f)

        size_mb = round(out_path.stat().st_size / 1024 / 1024, 2)
        return {"saved": str(out_path), "size_mb": size_mb}
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()}, status_code=500)

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
    Generates /data/hotspots_20min.json (persisted on the Railway volume).
    """
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        parquets = list(DATA_DIR.glob("*.parquet"))
        if not parquets:
            return JSONResponse(
                {"error": "No .parquet files found in /data. Upload first via /upload."},
                status_code=400
            )

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

        return {"ok": True, "output": str(OUT_PATH), "size_mb": round(OUT_PATH.stat().st_size / 1024 / 1024, 2)}
    except Exception as e:
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()}, status_code=500)

@app.get("/hotspots")
def hotspots():
    """
    This is what GitHub Pages should fetch:
    https://YOUR-RAILWAY-URL/hotspots
    """
    if not OUT_PATH.exists():
        return JSONResponse({"error": "hotspots_20min.json not generated yet. Call /generate first."}, status_code=404)
    return FileResponse(str(OUT_PATH), media_type="application/json", filename="hotspots_20min.json")

@app.get("/download")
def download():
    if not OUT_PATH.exists():
        return JSONResponse({"error": "hotspots_20min.json not generated yet. Call /generate first."}, status_code=404)
    return FileResponse(str(OUT_PATH), media_type="application/json", filename="hotspots_20min.json")