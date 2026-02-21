from fastapi import FastAPI, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
import traceback

from build_hotspots import build_hotspots_json

app = FastAPI(title="TLC Hotspot Builder API")

# CORS so your GitHub Pages site can fetch from Railway
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # you can lock this down later to your github.io domain
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Railway Volume should be mounted to /data
DATA_DIR = Path("/data")
DATA_DIR.mkdir(parents=True, exist_ok=True)

# Store output on the same persistent volume
OUT_PATH = DATA_DIR / "hotspots_20min.json"


@app.get("/")
def root():
    parquets = sorted([p.name for p in DATA_DIR.glob("*.parquet")])
    return {
        "status": "ok",
        "data_dir": str(DATA_DIR),
        "parquets": parquets,
        "has_output": OUT_PATH.exists(),
        "output_mb": round(OUT_PATH.stat().st_size / 1024 / 1024, 2) if OUT_PATH.exists() else 0,
    }


@app.get("/status")
def status():
    parquets = sorted([p.name for p in DATA_DIR.glob("*.parquet")])
    return {
        "status": "ok",
        "data_dir": str(DATA_DIR),
        "parquets": parquets,
        "has_output": OUT_PATH.exists(),
        "output_mb": round(OUT_PATH.stat().st_size / 1024 / 1024, 2) if OUT_PATH.exists() else 0,
    }


@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    """
    Upload parquet(s) to the persistent /data volume.
    """
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        out_path = DATA_DIR / file.filename
        content = await file.read()
        out_path.write_bytes(content)
        return {"saved": str(out_path), "size_mb": round(len(content) / 1024 / 1024, 2)}
    except Exception as e:
        return JSONResponse(
            {"error": str(e), "trace": traceback.format_exc()},
            status_code=500,
        )


@app.post("/generate")
def generate(
    bin_minutes: int = 20,
    good_n: int = 200,
    bad_n: int = 120,
    win_good_n: int = 80,
    win_bad_n: int = 40,
    min_trips_per_window: int = 10,
    simplify_meters: float = 25.0,
):
    """
    Build /data/hotspots_20min.json from the uploaded parquets.
    """
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        parquets = list(DATA_DIR.glob("*.parquet"))
        if not parquets:
            return JSONResponse(
                {"error": "No .parquet files found in /data. Upload first via /upload."},
                status_code=400,
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

        return {
            "ok": True,
            "output": str(OUT_PATH.name),
            "size_mb": round(OUT_PATH.stat().st_size / 1024 / 1024, 2),
        }
    except Exception as e:
        return JSONResponse(
            {"error": str(e), "trace": traceback.format_exc()},
            status_code=500,
        )


@app.get("/hotspots")
def hotspots():
    """
    Returns the generated JSON directly (for GitHub Pages fetch).
    """
    if not OUT_PATH.exists():
        return JSONResponse(
            {"error": "hotspots_20min.json not generated yet. Call POST /generate first."},
            status_code=404,
        )
    return FileResponse(
        str(OUT_PATH),
        media_type="application/json",
        filename="hotspots_20min.json",
    )


@app.get("/download")
def download():
    """
    Same as /hotspots, kept for backwards compatibility.
    """
    if not OUT_PATH.exists():
        return JSONResponse(
            {"error": "hotspots_20min.json not generated yet. Call POST /generate first."},
            status_code=404,
        )
    return FileResponse(
        str(OUT_PATH),
        media_type="application/json",
        filename="hotspots_20min.json",
    )