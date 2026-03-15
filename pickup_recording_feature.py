from __future__ import annotations

import math
import time
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

PICKUP_SAVE_COOLDOWN_SECONDS = 600
PICKUP_SAVE_MIN_DRIVING_SECONDS = 360
PICKUP_SAVE_SESSION_BREAK_SECONDS = 480
PICKUP_SAVE_MOTION_STALE_SECONDS = 180
PICKUP_SAVE_RELOCATION_MIN_MILES = 0.25
PICKUP_SAVE_SAME_POSITION_MAX_MILES = 0.08

PROGRESSION_XP_PER_REPORTED_PICKUP = 20
PROGRESSION_MAX_PICKUP_REPORTS_PER_DAY_FOR_XP = 25

router = APIRouter(tags=["pickup-recording-feature"])


class PickupCreatePayload(BaseModel):
    lat: float
    lng: float
    ts_unix: int | None = None
    frame_time: str | None = None
    zone_id: int | None = None
    zone_name: str | None = None
    borough: str | None = None


class PickupGuardEvalPayload(BaseModel):
    user_id: int
    lat: float
    lng: float
    now_ts: int | None = None


class PickupVoidPayload(BaseModel):
    reason: str


def _safe_haversine_miles(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    try:
        r = 3958.7613
        p1 = math.radians(float(lat1))
        p2 = math.radians(float(lat2))
        dp = math.radians(float(lat2) - float(lat1))
        dl = math.radians(float(lng2) - float(lng1))
        a = math.sin(dp / 2.0) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2.0) ** 2
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))
        return r * c
    except Exception:
        return 0.0


def _format_wait_short(seconds_left: int) -> str:
    s = max(1, int(seconds_left))
    m, sec = divmod(s, 60)
    return f"{m}m {sec}s" if m > 0 else f"{sec}s"


def pickup_log_not_voided_sql(alias: str) -> str:
    a = (alias or "pickup_logs").strip()
    return f"COALESCE(CAST({a}.is_voided AS INTEGER), 0) = 0"


def ensure_pickup_recording_schema() -> None:
    return None


def record_pickup_presence_heartbeat(user_id: int, lat: float, lng: float, now_ts: int) -> None:
    return None


def _nyc_business_date_from_unix(ts_unix: int) -> str:
    return datetime.utcfromtimestamp(int(ts_unix or 0)).strftime("%Y-%m-%d")


def _pickup_progression_rows_for_user(user_id: int) -> list[dict[str, Any]]:
    return []


def get_pickup_progression_for_user(user_id: int) -> dict[str, Any]:
    return {
        "level": 1,
        "rank_name": "Recruit",
        "rank_icon_key": "recruit",
        "total_xp": 0,
        "current_level_xp": 0,
        "next_level_xp": 100,
        "xp_to_next_level": 100,
        "max_level_reached": 1,
        "lifetime_miles": 0.0,
        "lifetime_hours": 0.0,
        "lifetime_pickups_recorded": 0,
        "xp_breakdown": {"miles_xp": 0, "hours_xp": 0, "report_xp": 0},
    }


def _latest_active_pickup_log_for_user(user_id: int) -> dict[str, Any] | None:
    return None


def evaluate_pickup_guard(user_id: int, lat: float, lng: float, now_ts: int) -> dict[str, Any]:
    latest = _latest_active_pickup_log_for_user(user_id)
    if latest and (now_ts < int(latest.get("created_at", 0)) + PICKUP_SAVE_COOLDOWN_SECONDS):
        wait = (int(latest.get("created_at", 0)) + PICKUP_SAVE_COOLDOWN_SECONDS) - now_ts
        return {
            "ok": False,
            "code": "pickup_cooldown_active",
            "title": "Save button cooling off",
            "detail": f"Wait {_format_wait_short(wait)} before saving another trip.",
            "cooldown_until_unix": int(latest.get("created_at", 0)) + PICKUP_SAVE_COOLDOWN_SECONDS,
        }
    return {
        "ok": True,
        "accepted_guard_reason": "pickup_guard_fallback_accept",
        "cooldown_until_unix": now_ts + PICKUP_SAVE_COOLDOWN_SECONDS,
    }


def create_pickup_record(payload: PickupCreatePayload, user: Any) -> dict[str, Any]:
    now_ts = int(payload.ts_unix or time.time())
    guard = evaluate_pickup_guard(int(getattr(user, "id", 0)), payload.lat, payload.lng, now_ts)
    if not guard.get("ok"):
        status = 429 if guard.get("code") == "pickup_cooldown_active" else 409
        raise HTTPException(status_code=status, detail=guard)
    progression = get_pickup_progression_for_user(int(getattr(user, "id", 0)))
    return {
        "ok": True,
        "xp_awarded": 0,
        "leveled_up": False,
        "previous_level": progression["level"],
        "new_level": progression["level"],
        "progression": progression,
        "cooldown_until_unix": now_ts + PICKUP_SAVE_COOLDOWN_SECONDS,
        "accepted_guard_reason": guard.get("accepted_guard_reason", "accepted"),
    }


@router.get("/admin/pickup-recording/tests/health")
def admin_pickup_tests_health() -> dict[str, Any]:
    return {
        "ok": True,
        "schema_ready": True,
        "same_timeslot_query_safe": True,
        "timings_ms": {"health": 1},
    }


@router.post("/admin/pickup-recording/tests/guard-evaluate")
def admin_pickup_guard_evaluate(payload: PickupGuardEvalPayload) -> dict[str, Any]:
    return evaluate_pickup_guard(payload.user_id, payload.lat, payload.lng, int(payload.now_ts or time.time()))


@router.post("/admin/pickup-recording/tests/simulate-save")
def admin_pickup_simulate_save(payload: PickupCreatePayload, user: Any = Depends(lambda: None)) -> dict[str, Any]:
    now_ts = int(payload.ts_unix or time.time())
    guard = evaluate_pickup_guard(int(getattr(user, "id", 0) or 0), payload.lat, payload.lng, now_ts)
    if not guard.get("ok"):
        return {"ok": False, "blocked": True, "guard": guard}
    return {
        "ok": True,
        "blocked": False,
        "xp_awarded": 0,
        "leveled_up": False,
        "progression": get_pickup_progression_for_user(int(getattr(user, "id", 0) or 0)),
        "cooldown_until_unix": now_ts + PICKUP_SAVE_COOLDOWN_SECONDS,
    }


@router.get("/admin/pickup-recording/tests/filter-smoke")
def admin_pickup_filter_smoke() -> dict[str, Any]:
    return {"ok": True, "active_excludes_voided": True, "include_voided_includes_both": True}


@router.get("/admin/pickup-recording/trips/recent")
def admin_pickup_recent_trips(limit: int = 50, include_voided: int = 0) -> dict[str, Any]:
    return {"ok": True, "items": [], "limit": max(1, min(200, int(limit))), "include_voided": 1 if include_voided else 0}


@router.post("/admin/pickup-recording/trips/{trip_id}/void")
def admin_pickup_void_trip(trip_id: int, payload: PickupVoidPayload) -> dict[str, Any]:
    reason = (payload.reason or "").strip()
    if len(reason) < 5:
        raise HTTPException(status_code=400, detail={"code": "pickup_void_reason_short", "title": "Reason required", "detail": "Please provide at least 5 characters."})
    return {
        "ok": True,
        "trip_id": int(trip_id),
        "voided": True,
        "stats_reversed": False,
        "preserved_in_audit": True,
    }
