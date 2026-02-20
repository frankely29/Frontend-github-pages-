#!/usr/bin/env python3
"""
TLC HVFHV Hotspot Builder (JSON for GitHub Pages / Phone)

Generates:
  - hotspots_20min.json  (default output filename, in repo root unless you change it)

JSON format:
{
  "bin_minutes": 20,
  "generated_at": "2026-02-20T23:59:59Z",
  "overall": {
     "good_ids": [...],
     "bad_ids": [...]
  },
  "frames": [
    {
      "time": "Mon 1:00 AM",
      "dow": "Mon",
      "bin_start_min": 60,
      "good_ids": [...],   # dynamic per-frame
      "bad_ids": [...],    # dynamic per-frame
      "zones": {
        "132": {"rating": 84, "score01": 0.83, "pickups": 120, "avg_driver_pay": 18.22, "avg_tips": 2.10},
        ...
      }
    },
    ...
  ]
}

Notes:
- This is designed to feed your JS map (index.html/app.js).
- It does NOT generate Folium HTML.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Tuple

import duckdb
import pandas as pd


DOW_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def ensure_dir(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def score_to_color_hex(score01: float) -> str:
    s = max(0.0, min(1.0, float(score01)))
    # red -> yellow -> green
    if s <= 0.5:
        t = s / 0.5
        r = int(lerp(230, 255, t))
        g = int(lerp(0, 215, t))
        b = 0
    else:
        t = (s - 0.5) / 0.5
        r = int(lerp(255, 0, t))
        g = int(lerp(215, 176, t))
        b = int(lerp(0, 80, t))
    return f"#{r:02x}{g:02x}{b:02x}"


def score_to_rating_1_100(score01: float) -> int:
    s = max(0.0, min(1.0, float(score01)))
    return int(round(1 + 99 * s))


def fmt_ampm(bin_start_min: int) -> str:
    # bin_start_min = minutes since midnight
    h24 = (bin_start_min // 60) % 24
    m = bin_start_min % 60
    ampm = "AM" if h24 < 12 else "PM"
    h12 = h24 % 12
    if h12 == 0:
        h12 = 12
    return f"{h12}:{m:02d} {ampm}"


def normalize_dow_to_mon0(dow_from_duckdb: int) -> int:
    """
    duckdb EXTRACT('dow'): 0=Sunday..6=Saturday
    we want: 0=Monday..6=Sunday
    """
    d = int(dow_from_duckdb)
    return 6 if d == 0 else d - 1


def minmax_series(s: pd.Series) -> pd.Series:
    s2 = pd.to_numeric(s, errors="coerce")
    mn = s2.min(skipna=True)
    mx = s2.max(skipna=True)
    if pd.isna(mn) or pd.isna(mx) or mx == mn:
        return pd.Series([0.0] * len(s2), index=s2.index)
    return (s2 - mn) / (mx - mn)


def build_window_aggregates(parquet_files: List[Path], bin_minutes: int) -> pd.DataFrame:
    con = duckdb.connect(database=":memory:")
    parquet_list = [str(p) for p in parquet_files]
    parquet_sql = ", ".join("'" + p.replace("'", "''") + "'" for p in parquet_list)

    sql = f"""
    WITH base AS (
      SELECT
        CAST(PULocationID AS INTEGER) AS PULocationID,
        pickup_datetime,
        TRY_CAST(driver_pay AS DOUBLE) AS driver_pay,
        TRY_CAST(tips AS DOUBLE) AS tips
      FROM read_parquet([{parquet_sql}])
      WHERE PULocationID IS NOT NULL AND pickup_datetime IS NOT NULL
    ),
    t AS (
      SELECT
        PULocationID,
        EXTRACT('dow' FROM pickup_datetime) AS dow_i,  -- 0=Sun..6=Sat
        EXTRACT('hour' FROM pickup_datetime) AS hour_i,
        EXTRACT('minute' FROM pickup_datetime) AS minute_i,
        driver_pay,
        tips
      FROM base
    ),
    binned AS (
      SELECT
        PULocationID,
        dow_i,
        CAST(FLOOR((hour_i*60 + minute_i) / {int(bin_minutes)}) * {int(bin_minutes)} AS INTEGER) AS bin_start_min,
        driver_pay,
        tips
      FROM t
    )
    SELECT
      PULocationID,
      dow_i,
      bin_start_min,
      COUNT(*) AS pickups,
      AVG(driver_pay) AS avg_driver_pay,
      AVG(tips) AS avg_tips
    FROM binned
    GROUP BY 1,2,3;
    """

    df = con.execute(sql).df()
    if df.empty:
        return df

    df["PULocationID"] = df["PULocationID"].astype(int)
    df["dow_i"] = df["dow_i"].astype(int)
    df["dow_m"] = df["dow_i"].apply(normalize_dow_to_mon0).astype(int)
    df["dow"] = df["dow_m"].apply(lambda i: DOW_NAMES[int(i)])
    df["bin_start_min"] = df["bin_start_min"].astype(int)
    df["pickups"] = df["pickups"].astype(int)
    return df


def add_scores(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df

    out = df.copy()

    # normalize within each (dow_m, bin_start_min) across zones
    out["vol_n"] = out.groupby(["dow_m", "bin_start_min"])["pickups"].transform(minmax_series)
    out["pay_n"] = out.groupby(["dow_m", "bin_start_min"])["avg_driver_pay"].transform(minmax_series)
    out["tip_n"] = out.groupby(["dow_m", "bin_start_min"])["avg_tips"].transform(minmax_series)

    out["score01"] = (0.60 * out["vol_n"]) + (0.30 * out["pay_n"]) + (0.10 * out["tip_n"])
    out["rating"] = out["score01"].apply(score_to_rating_1_100).astype(int)
    out["color"] = out["score01"].apply(score_to_color_hex)
    return out


def overall_good_bad(df_scored: pd.DataFrame, good_n: int, bad_n: int) -> Tuple[List[int], List[int]]:
    # overall by total pickups across ALL windows
    totals = df_scored.groupby("PULocationID", as_index=False)["pickups"].sum().rename(columns={"pickups": "pickups_total"})
    totals = totals.sort_values("pickups_total", ascending=False)

    good_ids = totals.head(int(good_n))["PULocationID"].astype(int).tolist()

    rest = totals[~totals["PULocationID"].astype(int).isin(set(good_ids))].copy()
    bad_ids = rest.sort_values("pickups_total", ascending=True).head(int(bad_n))["PULocationID"].astype(int).tolist()

    return good_ids, bad_ids


def per_frame_good_bad(df_scored: pd.DataFrame, win_good_n: int, win_bad_n: int) -> pd.DataFrame:
    # rank within each frame by score01
    df = df_scored.copy()
    df["rank_good"] = df.groupby(["dow_m", "bin_start_min"])["score01"].rank(method="first", ascending=False)
    df["rank_bad"] = df.groupby(["dow_m", "bin_start_min"])["score01"].rank(method="first", ascending=True)
    df["is_good"] = df["rank_good"] <= int(win_good_n)
    df["is_bad"] = df["rank_bad"] <= int(win_bad_n)
    return df


def build_frames_payload(
    df: pd.DataFrame,
    overall_good_ids: List[int],
    overall_bad_ids: List[int],
    min_trips_per_window: int,
    win_good_n: int,
    win_bad_n: int,
) -> List[Dict]:
    if df.empty:
        return []

    # filter weak windows
    df = df[df["pickups"] >= int(min_trips_per_window)].copy()

    df = per_frame_good_bad(df, win_good_n=win_good_n, win_bad_n=win_bad_n)

    frames: List[Dict] = []

    # group per frame
    for (dow_m, bin_start_min), g in df.groupby(["dow_m", "bin_start_min"], sort=True):
        dow_m = int(dow_m)
        bin_start_min = int(bin_start_min)
        dow = DOW_NAMES[dow_m]
        time_label = f"{dow} {fmt_ampm(bin_start_min)}"

        # dynamic good/bad for THIS frame
        good_ids = g[g["is_good"]]["PULocationID"].astype(int).tolist()
        bad_ids = g[g["is_bad"]]["PULocationID"].astype(int).tolist()

        # zones dict
        zones: Dict[str, Dict] = {}
        for _, r in g.iterrows():
            zid = int(r["PULocationID"])
            zones[str(zid)] = {
                "rating": int(r["rating"]),
                "score01": float(r["score01"]),
                "pickups": int(r["pickups"]),
                "avg_driver_pay": None if pd.isna(r["avg_driver_pay"]) else float(r["avg_driver_pay"]),
                "avg_tips": None if pd.isna(r["avg_tips"]) else float(r["avg_tips"]),
                # optional helper if your JS wants it
                "color": str(r["color"]),
            }

        frames.append({
            "time": time_label,
            "dow": dow,
            "bin_start_min": bin_start_min,
            "good_ids": good_ids,
            "bad_ids": bad_ids,
            "zones": zones,
        })

    return frames


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--data_dir", type=str, default="data", help="Folder containing fhvhv_tripdata_YYYY-MM.parquet files")
    p.add_argument("--months", nargs="+", required=True, help="e.g. 2025-09 2025-10 2025-11")
    p.add_argument("--bin_minutes", type=int, default=20)

    # overall lists (used for legend/static marker sets if you want)
    p.add_argument("--good_n", type=int, default=200)
    p.add_argument("--bad_n", type=int, default=120)

    # per frame lists (dynamic icons)
    p.add_argument("--win_good_n", type=int, default=80)
    p.add_argument("--win_bad_n", type=int, default=40)

    p.add_argument("--min_trips_per_window", type=int, default=10)

    p.add_argument("--out_file", type=str, default="hotspots_20min.json", help="Output JSON filename")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    bin_minutes = max(1, int(args.bin_minutes))

    data_dir = Path(args.data_dir).expanduser().resolve()
    months = list(args.months)

    parquet_files: List[Path] = []
    for m in months:
        p = data_dir / f"fhvhv_tripdata_{m}.parquet"
        if not p.exists():
            raise FileNotFoundError(f"Missing parquet: {p}")
        parquet_files.append(p)

    df = build_window_aggregates(parquet_files, bin_minutes=bin_minutes)
    if df.empty:
        payload = {"bin_minutes": bin_minutes, "generated_at": utc_now_iso(), "overall": {"good_ids": [], "bad_ids": []}, "frames": []}
        Path(args.out_file).write_text(json.dumps(payload), encoding="utf-8")
        print(f"Wrote {args.out_file} (EMPTY - no rows)")
        return 0

    df_scored = add_scores(df)

    overall_good_ids, overall_bad_ids = overall_good_bad(
        df_scored, good_n=int(args.good_n), bad_n=int(args.bad_n)
    )

    frames = build_frames_payload(
        df_scored,
        overall_good_ids=overall_good_ids,
        overall_bad_ids=overall_bad_ids,
        min_trips_per_window=int(args.min_trips_per_window),
        win_good_n=int(args.win_good_n),
        win_bad_n=int(args.win_bad_n),
    )

    payload = {
        "bin_minutes": bin_minutes,
        "generated_at": utc_now_iso(),
        "overall": {
            "good_ids": overall_good_ids,
            "bad_ids": overall_bad_ids,
        },
        "frames": frames,
    }

    out_path = Path(args.out_file).expanduser().resolve()
    out_path.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {out_path} with {len(frames)} frames")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
