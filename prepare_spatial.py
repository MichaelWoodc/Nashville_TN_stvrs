"""Metric parcel distances, Davidson County outline, and reproducible 500 m cells.

Run `python prepare_spatial.py --download-boundary` once to obtain the official
county outline. Builds thereafter use the saved file; no automatic network fetch.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlencode
from urllib.request import urlopen

BOUNDARY_SERVICE = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1'
SPATIAL_VERSION = 3
CELL_METERS = 500


def download_boundary(root):
    from build_nashville import write_json
    query = urlencode({'where': "STATE='47' AND COUNTY='037'", 'outFields': 'GEOID,NAME,STATE,COUNTY',
                       'returnGeometry': 'true', 'outSR': 4326, 'f': 'geojson'})
    url = BOUNDARY_SERVICE + '/query?' + query
    with urlopen(url, timeout=60) as response:
        data = json.load(response)
    if len(data.get('features', [])) != 1 or data['features'][0]['properties'].get('GEOID') != '47037':
        raise ValueError('Expected only Davidson County, TN (47037); no boundary written')
    data['source'] = {'url': url, 'service': BOUNDARY_SERVICE, 'name': 'U.S. Census TIGERweb Davidson County',
                      'vintage': 'January 1, 2026', 'downloaded_at': datetime.now(timezone.utc).isoformat()}
    write_json(root/'geography/davidson_county.geojson', data)
    print('Saved official Davidson County outline.', flush=True)


def signed_edge_distance(point, boundary):
    distance = point.distance(boundary.boundary)
    return distance if boundary.covers(point) else -distance


def circle_overlaps_parcel(distance_meters, radius_meters, leeway_percent=10, parcel_tolerance_m=0):
    """None means insufficient information; zero radius tests the source point."""
    if distance_meters is None or radius_meters is None or radius_meters < 0:
        return None
    return distance_meters <= radius_meters * (1 + leeway_percent/100) + parcel_tolerance_m + 1e-6


def annotate_spatial(root, output, listings, permits, parcels_available):
    from build_nashville import write_json, file_signature
    boundary_path = root/'geography/davidson_county.geojson'
    parcel_path = output/'data/licensed_parcels.geojson'
    if not boundary_path.exists() or not parcels_available:
        return {'available': False, 'reason': 'County outline or licensed parcel geometry unavailable'}
    from pyproj import Transformer
    from shapely.geometry import Point, box, shape, mapping
    from shapely.ops import transform, unary_union
    from shapely import make_valid
    from shapely.strtree import STRtree

    forward = Transformer.from_crs('EPSG:4326', 'EPSG:26916', always_xy=True).transform
    inverse = Transformer.from_crs('EPSG:26916', 'EPSG:4326', always_xy=True).transform
    raw = json.loads(boundary_path.read_text(encoding='utf-8'))
    boundary = unary_union([transform(forward, make_valid(shape(f['geometry']))) for f in raw['features']])
    signature = [SPATIAL_VERSION, file_signature(boundary_path), file_signature(parcel_path)]
    cache_path = root/'.nashville_cache/spatial.json'
    try:
        cache = json.loads(cache_path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        cache = {}
    if cache.get('signature') != signature:
        cache = {'signature': signature, 'points': {}}
    geometries = None
    tree = None
    cells = {}
    all_records = listings + [p for p in permits if p['status'] == 'current']
    for record in all_records:
        coords = record.get('point')
        if not coords:
            continue
        key = ','.join(str(c) for c in coords)
        if key not in cache['points']:
            point = transform(forward, Point(coords))
            if geometries is None:
                parcel_data = json.loads(parcel_path.read_text(encoding='utf-8'))
                geometries = [transform(forward, make_valid(shape(f['geometry']))) for f in parcel_data['features']]
                geometries = [g for g in geometries if not g.is_empty]
                tree = STRtree(geometries)
            nearest_index = tree.nearest(point) if geometries else None
            nearest = float(point.distance(geometries[int(nearest_index)])) if nearest_index is not None else None
            cache['points'][key] = {'nearest_licensed_parcel_m': nearest,
                                     'boundary_distance_m': signed_edge_distance(point, boundary),
                                     'cell_id': f'{math.floor(point.x/CELL_METERS)}_{math.floor(point.y/CELL_METERS)}'}
        record.update(cache['points'][key])
        cid = record['cell_id']
        if cid not in cells:
            x, y = (int(v)*CELL_METERS for v in cid.split('_'))
            geometry = box(x, y, x+CELL_METERS, y+CELL_METERS)
            cells[cid] = {'type': 'Feature', 'geometry': mapping(transform(inverse, geometry)),
                          'properties': {'cell_id': cid, 'center': list(inverse(x+250, y+250))}}
    write_json(cache_path, cache)
    # Only redraw buffers when geography changes. Classification uses the unsimplified outline.
    geography_signature = hashlib.sha256(json.dumps(signature).encode()).hexdigest()
    spatial_path = output/'data/spatial.json'
    existing = json.loads(spatial_path.read_text(encoding='utf-8')) if spatial_path.exists() else {}
    if existing.get('geography_signature') == geography_signature:
        buffers = existing['buffers']
        buffer_bands = existing['buffer_bands']
    else:
        buffers = {str(m): {'type':'Feature', 'geometry': mapping(transform(inverse, boundary.buffer(m).simplify(3, preserve_topology=True))),
                            'properties': {'edge_buffer_m': m}} for m in range(-550, 551, 50)}
        buffer_bands = {str(m): {'type':'Feature', 'geometry': mapping(transform(inverse, boundary.symmetric_difference(boundary.buffer(m)).simplify(3, preserve_topology=True))),
                                 'properties': {'edge_buffer_m': m}} for m in range(-550, 551, 50) if m != 0}
    data = {'available': True, 'geography_signature': geography_signature,
            'boundary': raw, 'buffers': buffers, 'buffer_bands':buffer_bands, 'cells': list(cells.values()), 'cell_size_m': CELL_METERS,
            'source': raw.get('source', {'url': BOUNDARY_SERVICE}),
            'method': 'EPSG:26916 point-to-polygon distance; no permit-point radius used for parcel overlap.'}
    write_json(spatial_path, data)
    mapped = [l for l in listings if l.get('point') and l.get('boundary_distance_m', -1) >= 0]
    return {'available': True, 'cell_size_m': CELL_METERS, 'source': data['source'],
            'in_county_listings': len(mapped),
            'default_parcel_tolerance_m':9.144,
            'likely_unlicensed_default': sum(circle_overlaps_parcel(l.get('nearest_licensed_parcel_m'), l.get('privacy_radius_meters'),parcel_tolerance_m=9.144) is False for l in mapped),
            'unknown_radius_in_county': sum(l.get('privacy_radius_meters') is None for l in mapped)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download-boundary', action='store_true', required=True)
    parser.parse_args()
    download_boundary(Path(__file__).resolve().parent)
