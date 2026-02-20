# TLC FHV Hotspot Map (Uber/Lyft)

This repo builds an interactive HTML hotspot map from NYC TLC FHVHV tripdata parquet files.

## Local setup
1) Create/activate venv and install requirements:
- python -m venv .venv
- .\.venv\Scripts\activate
- pip install -r requirements.txt

2) Put parquet files into:
- .\data\fhvhv_tripdata_YYYY-MM.parquet

## Build the map
Run:
- .\scripts\build_map.ps1

## View the map
Run:
- .\scripts\serve_map.ps1
Then open the printed localhost link.

> Note: data/ and outputs/ are ignored by git (too large). Build locally.
