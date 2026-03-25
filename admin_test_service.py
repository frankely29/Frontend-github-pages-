import json
import os
from typing import Any, Dict
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def _base_url() -> str:
    return os.getenv("ADMIN_TEST_BACKEND_BASE_URL", "http://127.0.0.1:8000").rstrip("/")


def _fetch_json(url: str, timeout: float = 5.0) -> Dict[str, Any]:
    request = Request(url, method="GET")
    with urlopen(request, timeout=timeout) as response:  # nosec B310
        body = response.read().decode("utf-8")
    payload = json.loads(body or "{}")
    return payload if isinstance(payload, dict) else {}


def test_build_sync() -> Dict[str, Any]:
    url = f"{_base_url()}/status"
    try:
        payload = _fetch_json(url)
    except (HTTPError, URLError, TimeoutError, ValueError) as exc:
        return {
            "ok": False,
            "summary": "Backend build identity missing",
            "details": {
                "backend_build_id": None,
                "backend_release": None,
                "frames_dir": "",
                "manifest_present": False,
                "timeline_present": False,
                "error": str(exc),
            },
        }

    backend_build_id = payload.get("backend_build_id")
    backend_release = payload.get("backend_release")
    frames_dir = payload.get("frames_dir") or ""
    manifest_present = bool(payload.get("manifest_present"))
    timeline_present = bool(payload.get("timeline_present"))
    available = bool(str(backend_build_id or "").strip() or str(backend_release or "").strip())

    return {
        "ok": available,
        "summary": "Backend build identity available" if available else "Backend build identity missing",
        "details": {
            "backend_build_id": backend_build_id,
            "backend_release": backend_release,
            "frames_dir": frames_dir,
            "manifest_present": manifest_present,
            "timeline_present": timeline_present,
        },
    }
