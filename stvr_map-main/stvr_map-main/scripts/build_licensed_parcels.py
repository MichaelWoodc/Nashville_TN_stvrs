"""Extract parcel geometries that have a current county license."""
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LICENSES = ROOT / "data/county_licenses/county_licensed_locations.geojson"
PARCEL_DIR = ROOT / "data/geography_files/split_parcels"
OUTPUT = ROOT / "data/geography_files/licensed_parcels.geojson"


def normalize_pin(value):
    return "".join(str(value or "").upper().split())


def main():
    license_data = json.loads(LICENSES.read_text(encoding="utf-8"))
    licensed_pins = {
        normalize_pin(feature.get("properties", {}).get("Parcel_PIN"))
        for feature in license_data.get("features", [])
    }
    licensed_pins.discard("")

    matched_features = []
    for path in sorted(PARCEL_DIR.glob("Parcel_Digest_2025_part*.geojson")):
        parcel_data = json.loads(path.read_text(encoding="utf-8"))
        for feature in parcel_data.get("features", []):
            properties = feature.get("properties") or {}
            if normalize_pin(properties.get("PIN")) not in licensed_pins:
                continue
            matched_features.append({
                "type": "Feature",
                "geometry": feature.get("geometry"),
                "properties": {
                    "PIN": properties.get("PIN"),
                    "PropAddress_Full": properties.get("PropAddress_Full", ""),
                    "PropAddress_City": properties.get("PropAddress_City", ""),
                    "PropAddress_State": properties.get("PropAddress_State", "GA"),
                    "PropAddress_Zip": properties.get("PropAddress_Zip", ""),
                    "_hasLicense": True,
                },
            })

    output_data = {
        "type": "FeatureCollection",
        "features": matched_features,
    }
    OUTPUT.write_text(json.dumps(output_data, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {len(matched_features):,} licensed parcels from {len(licensed_pins):,} license PINs to {OUTPUT}")


if __name__ == "__main__":
    main()