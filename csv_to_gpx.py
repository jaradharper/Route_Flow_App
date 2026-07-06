#!/usr/bin/env python3
"""
Convert a geocoded CSV into a GPX file for Figma Map Maker.

Input CSV must include latitude/longitude columns. Common names supported:
lat, latitude, y, Latitude
lon, lng, longitude, x, Longitude

Usage:
python csv_to_gpx.py geocoded_addresses.csv routeflow_markers.gpx
"""

import csv
import html
import sys
from pathlib import Path

LAT_NAMES = ["lat", "latitude", "y", "Latitude", "LAT", "Latitude "]
LON_NAMES = ["lon", "lng", "long", "longitude", "x", "Longitude", "LON", "LNG", "Longitude "]
NAME_NAMES = ["Company / Account", "Company", "Account", "Name", "Business Name", "name"]

def pick_field(fields, names):
    lower_map = {f.strip().lower(): f for f in fields}
    for n in names:
        if n.strip().lower() in lower_map:
            return lower_map[n.strip().lower()]
    return None

def main():
    if len(sys.argv) != 3:
        print("Usage: python csv_to_gpx.py geocoded_addresses.csv routeflow_markers.gpx")
        sys.exit(1)

    input_csv = Path(sys.argv[1])
    output_gpx = Path(sys.argv[2])

    with input_csv.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fields = reader.fieldnames or []

        lat_field = pick_field(fields, LAT_NAMES)
        lon_field = pick_field(fields, LON_NAMES)
        name_field = pick_field(fields, NAME_NAMES)

        if not lat_field or not lon_field:
            raise ValueError(f"Could not find latitude/longitude columns. Found columns: {fields}")

        waypoints = []
        skipped = 0

        for row in reader:
            lat = (row.get(lat_field) or "").strip()
            lon = (row.get(lon_field) or "").strip()
            if not lat or not lon:
                skipped += 1
                continue

            try:
                float(lat)
                float(lon)
            except ValueError:
                skipped += 1
                continue

            name = (row.get(name_field) or row.get("Full Address") or "Prospect").strip()
            address = (row.get("Full Address") or "").strip()

            desc_parts = []
            if address:
                desc_parts.append(address)
            desc = " | ".join(desc_parts)

            waypoints.append((lat, lon, name, desc))

    gpx = ['<?xml version="1.0" encoding="UTF-8"?>']
    gpx.append('<gpx version="1.1" creator="RouteFlow CSV to GPX" xmlns="http://www.topografix.com/GPX/1/1">')

    for lat, lon, name, desc in waypoints:
        gpx.append(f'  <wpt lat="{html.escape(lat)}" lon="{html.escape(lon)}">')
        gpx.append(f'    <name>{html.escape(name)}</name>')
        if desc:
            gpx.append(f'    <desc>{html.escape(desc)}</desc>')
        gpx.append('  </wpt>')

    gpx.append('</gpx>')
    output_gpx.write_text("\n".join(gpx), encoding="utf-8")

    print(f"Created {output_gpx} with {len(waypoints)} markers. Skipped {skipped} rows without valid coordinates.")

if __name__ == "__main__":
    main()
