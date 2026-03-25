import os
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI

app = FastAPI()


def _optional_env(name: str) -> Optional[str]:
    value = os.getenv(name)
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


def _resolve_frames_dir() -> str:
    return os.getenv("FRAMES_DIR", "").strip()


def _path_flag(frames_dir: str, filename: str) -> bool:
    if not frames_dir:
        return False
    return Path(frames_dir, filename).exists()


@app.get("/status")
def status() -> Dict[str, Any]:
    frames_dir = _resolve_frames_dir()
    payload: Dict[str, Any] = {
        "ok": True,
        "backend_build_id": _optional_env("BACKEND_BUILD_ID"),
        "backend_release": _optional_env("BACKEND_RELEASE"),
        "frames_dir": frames_dir,
        "manifest_present": _path_flag(frames_dir, "manifest.json"),
        "timeline_present": _path_flag(frames_dir, "timeline.json"),
    }
    return payload
