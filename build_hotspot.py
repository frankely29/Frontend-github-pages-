#!/usr/bin/env python3
"""Build hotspot/scoring shadow manifest.

This repository snapshot did not contain a backend manifest builder, so this
script provides the scoring_shadow_manifest.json generation block expected by
frontend/runtime consumers.
"""

from __future__ import annotations

import json
from pathlib import Path


def build_scoring_shadow_manifest(output_path: str | Path = "scoring_shadow_manifest.json") -> dict:
    """Create and persist the Team Joseo scoring shadow manifest."""
    manifest = {
        "engine_version": "team-joseo-score-v2-final-live",
        "base_color_truth": "tlc_hvfhv_earnings_opportunity",
        "active_shadow_profile": "citywide_v2",  # backward-compat for older consumers
        "default_citywide_profile": "citywide_v2",
        "all_profiles_live": True,
        "active_shadow_profiles": [
            "citywide_v2",
            "manhattan_v2",
            "bronx_wash_heights_v2",
            "queens_v2",
            "brooklyn_v2",
            "staten_island_v2",
        ],
        "visible_profiles_live": [
            "citywide_v2",
            "manhattan_v2",
            "bronx_wash_heights_v2",
            "queens_v2",
            "brooklyn_v2",
            "staten_island_v2",
        ],
        "notes": [
            "active_shadow_profile is retained for backward compatibility.",
            "default_citywide_profile and all_profiles_live represent current truth.",
        ],
        "shadow_fields": [
            "earnings_shadow_score_citywide_v2",
            "earnings_shadow_confidence_citywide_v2",
            "earnings_shadow_rating_citywide_v2",
            "earnings_shadow_bucket_citywide_v2",
            "earnings_shadow_color_citywide_v2",
            "earnings_shadow_score_manhattan_v2",
            "earnings_shadow_confidence_manhattan_v2",
            "earnings_shadow_rating_manhattan_v2",
            "earnings_shadow_bucket_manhattan_v2",
            "earnings_shadow_color_manhattan_v2",
            "earnings_shadow_score_bronx_wash_heights_v2",
            "earnings_shadow_confidence_bronx_wash_heights_v2",
            "earnings_shadow_rating_bronx_wash_heights_v2",
            "earnings_shadow_bucket_bronx_wash_heights_v2",
            "earnings_shadow_color_bronx_wash_heights_v2",
            "earnings_shadow_score_queens_v2",
            "earnings_shadow_confidence_queens_v2",
            "earnings_shadow_rating_queens_v2",
            "earnings_shadow_bucket_queens_v2",
            "earnings_shadow_color_queens_v2",
            "earnings_shadow_score_brooklyn_v2",
            "earnings_shadow_confidence_brooklyn_v2",
            "earnings_shadow_rating_brooklyn_v2",
            "earnings_shadow_bucket_brooklyn_v2",
            "earnings_shadow_color_brooklyn_v2",
            "earnings_shadow_score_staten_island_v2",
            "earnings_shadow_confidence_staten_island_v2",
            "earnings_shadow_rating_staten_island_v2",
            "earnings_shadow_bucket_staten_island_v2",
            "earnings_shadow_color_staten_island_v2",
        ],
    }

    out = Path(output_path)
    out.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return manifest


if __name__ == "__main__":
    build_scoring_shadow_manifest()
