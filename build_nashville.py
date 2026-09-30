"""Rebuild the Nashville static map from local snapshots; Python 3.10+.

python build_nashville.py
python build_nashville.py --watch --serve 8765
Original data is never modified. See README_NASHVILLE.md for data contracts.
"""
from __future__ import annotations
import argparse
import csv
import hashlib
import http.server
import json
import math
import os
from pathlib import Path
import re
import shutil
import threading
import time
import unicodedata
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from functools import partial

ROOT = Path(__file__).resolve().parent
RULES = 'https://www.nashville.gov/departments/codes/short-term-rentals/operation-rules-and-requirements'
PORTAL = 'https://datanashvillegov-nashville.hub.arcgis.com/datasets/b5315bda43ac459281dd35f04aa1be32_0/explore?location=36.185179%2C-86.792167%2C10'
SCANNER_VERSION = 3
FILE_IO_LOCK = threading.RLock()


def atomic_text(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    with FILE_IO_LOCK:
        temp.write_text(value, encoding='utf-8')
        try:
            os.replace(temp, path)
        except PermissionError:
            # Some Windows environments permit writing but deny replacement of
            # existing files. The preview server shares this lock, so it cannot
            # read partial JSON during the compatible in-place fallback.
            path.write_text(value, encoding='utf-8')
            try:
                temp.unlink()
            except OSError:
                pass


def atomic_bytes(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    with FILE_IO_LOCK:
        temp.write_bytes(value)
        try:
            os.replace(temp, path)
        except PermissionError:
            path.write_bytes(value)
            try:
                temp.unlink()
            except OSError:
                pass


def write_json(path, value):
    atomic_text(path, json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False))


def read_csv(path):
    if not path.exists():
        return []
    with path.open(encoding='utf-8-sig', newline='') as stream:
        return list(csv.DictReader(stream))


def write_csv(path, rows, fields=None):
    import io
    output = io.StringIO(newline='')
    fields = fields or list(dict.fromkeys(k for row in rows for k in row))
    writer = csv.DictWriter(output, fieldnames=fields, extrasaction='ignore')
    writer.writeheader()
    for row in rows:
        writer.writerow({k: json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v for k, v in row.items()})
    atomic_text(path, output.getvalue())


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (ValueError, TypeError):
        return None


def point(lon, lat):
    lon, lat = number(lon), number(lat)
    return [lon, lat] if lon is not None and lat is not None and -180 <= lon <= 180 and -90 <= lat <= 90 and (lon or lat) else None


def listing_id(row):
    match = re.search(r'/rooms/(\d+)', str(row.get('url', '')))
    if match:
        return match[1]
    value = str(row.get('listing_id', ''))
    return value if re.fullmatch(r'\d+', value) else ''


def permit_key(value):
    """Only whole permit identifiers; never extract numbers from an address."""
    value = re.sub(r'[\s#_-]', '', str(value or '')).upper()
    match = re.fullmatch(r'(?:CASR|STRP?|T)?(20\d{8})', value)
    return match[1] if match else ''


def normalize_text(text):
    return ''.join(c for c in unicodedata.normalize('NFKC', text) if unicodedata.category(c) != 'Cf')


def extract_permits(text, source):
    """Keep evidence; exact 10-digit IDs or explicit year/serial reconstruction."""
    text = normalize_text(text)
    results = []
    patterns = [
        (r'(?<!\d)(?:CASR[\s:#_-]*|STRP?[\s:#_-]*|T)?20\d{8}(?!\d)', 'exact'),
        (r'\b20\d{2}(?:[\s_:#-]|followed\s*by|fol+owed\s*by){1,35}\d{1,6}(?:(?:[\s_:#-]|followed\s*by|fol+owed\s*by){1,35}\d{1,3})?', 'formatted'),
    ]
    for pattern, method in patterns:
        for match in re.finditer(pattern, text, re.I):
            start, end = match.span()
            context = text[max(0, start-100):min(len(text), end+100)].strip()
            # Number-only hits need a permit-related context, avoiding phones/host IDs.
            if not re.search(r'permit|licen[sc]e|registration|\bCASR\b|\bSTR\b', context, re.I):
                continue
            digits = re.sub(r'\D', '', match.group())
            if method == 'formatted' and 5 <= len(digits) <= 10:
                digits = digits[:4] + digits[4:].zfill(6)
            if not permit_key(digits):
                continue
            result = {'number': digits, 'raw': match.group(), 'method': method, 'source': source, 'evidence': context}
            if not any(r['number'] == digits for r in results):
                results.append(result)
    return results


AMENITIES = {'pool': r'\bpool\b(?!\s+table)', 'hot_tub': r'\b(?:hot\s*tub|jacuzzi)\b',
             'bar': r'\bbar\b', 'pool_table': r'\bpool\s+table\b', 'karaoke': r'karaoke',
             'bachelor_party': r'\bbachelor(?:\s+(?:party|weekend|trip))?\b',
             'bachelorette_party': r'\bbachelorette(?:\s+(?:party|weekend|trip))?\b'}


def scan_text(text, source):
    normalized = normalize_text(text)
    amenities = {}
    for key, pattern in AMENITIES.items():
        match = re.search(pattern, normalized, re.I)
        if match:
            amenities[key] = {'source': source, 'evidence': normalized[max(0, match.start()-55):match.end()+80].strip()}
    return extract_permits(text, source), amenities


def capacity(bedrooms, guests):
    bedrooms, guests = number(bedrooms), number(guests)
    if bedrooms is None or bedrooms < 0:
        return None, max(0, guests-12) if guests is not None and guests > 12 else None
    allowed = min(2*bedrooms + 4, 12)
    return allowed, max(0, guests-allowed) if guests is not None else None


def capacity_for_detected_licenses(bedrooms, guests, license_count):
    """Estimate two units only when exactly two listing numbers were detected."""
    if license_count != 2:
        return capacity(bedrooms, guests)
    bedrooms, guests = number(bedrooms), number(guests)
    if bedrooms is None or bedrooms < 0:
        return None, max(0, guests-24) if guests is not None and guests > 24 else None
    allowed = min(24, 2*bedrooms + 8)
    return allowed, max(0, guests-allowed) if guests is not None else None


def parse_date(value):
    if not value:
        return None
    for fmt in ['%m/%d/%Y', '%Y-%m-%d']:
        try:
            return datetime.strptime(str(value).split(' ')[0], fmt).date()
        except ValueError:
            pass
    return None


def permit_status(status, expiration, as_of):
    status = str(status).strip().upper()
    expiry = parse_date(expiration)
    if status == 'EXPIRED':
        return 'expired'
    if status == 'ISSUED':
        return 'expired' if expiry and expiry < as_of else 'current'
    return status.lower() or 'unknown'


def load_permits(root, as_of):
    rows = read_csv(root / 'nashville_permits/nashville_permits.csv')
    # Optional authoritative crosswalk: object_id,permit_number,source_url.
    crosswalk = {r['object_id']: r for r in read_csv(root / 'permit_number_crosswalk.csv') if r.get('source_url')}
    permits, by_number = [], defaultdict(list)
    for index, row in enumerate(rows):
        oid = str(row.get('ObjectId') or index+1)
        cross = crosswalk.get(oid, {})
        raw_number = cross.get('permit_number') or row.get('Permit #', '')
        key = permit_key(raw_number)
        p = {'id': oid, 'permit_number': key, 'source_permit_field': row.get('Permit #', ''),
             'address': row.get('Address', ''), 'parcel': row.get('Parcel', ''),
             'owner': row.get('Permit Owner Name', ''), 'type': row.get('Permit Subtype Description', ''),
             'source_status': row.get('Permit Status', ''), 'expiration': row.get('Expiration Date', ''),
             'issued': row.get('Date Issued', ''), 'point': point(row.get('Longitude'), row.get('Latitude')),
             'status': permit_status(row.get('Permit Status'), row.get('Expiration Date'), as_of),
             'source_url': cross.get('source_url') or PORTAL}
        permits.append(p)
        if key:
            by_number[key].append(p)
    return permits, by_number


def file_signature(path):
    stat = path.stat()
    return [stat.st_size, stat.st_mtime_ns]


def collect_listings(root, cache_path):
    try:
        cache = json.loads(cache_path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        cache = {}
    rows, repairs, warnings = {}, [], []
    # URL inventory preserves not-yet-scraped listings in the output table.
    for row in read_csv(root / 'listing_urls.csv'):
        lid = listing_id(row)
        if lid:
            rows[lid] = {'listing_id': lid, 'url': f'https://www.airbnb.com/rooms/{lid}'}
    for row in read_csv(root / 'listing_details.csv'):
        lid = listing_id(row)
        if lid:
            rows.setdefault(lid, {}).update({k: v for k, v in row.items() if v not in ('', None)})
    folders = sorted(p for p in (root / 'listing_results').iterdir() if p.is_dir() and p.name.isdigit())
    for folder in folders:
        lid = folder.name
        row = rows.setdefault(lid, {'listing_id': lid, 'url': f'https://www.airbnb.com/rooms/{lid}'})
        files = [p for p in [folder/'metadata.json', folder/'details.txt'] if p.exists()]
        signature = [SCANNER_VERSION, [(p.name, file_signature(p)) for p in files]]
        old = cache.get(lid, {})
        if old.get('signature') == json.loads(json.dumps(signature)):
            saved = old
        else:
            saved = {'signature': signature, 'metadata': {}, 'header': {}, 'permits': [], 'amenities': {}, 'capacity': {}}
            try:
                for path in files:
                    text = path.read_text(encoding='utf-8-sig')
                    if path.suffix == '.json':
                        metadata = json.loads(text)
                        if not isinstance(metadata, dict):
                            raise ValueError('metadata must be a JSON object')
                        saved['metadata'] = metadata
                        text = '\n'.join(f'{k}: {v}' for k, v in metadata.items() if any(w in k.lower() for w in ['description', 'title', 'registration', 'license', 'permit', 'amenit', 'rule']))
                    else:
                        # Saved scrape headers, not arbitrary narrative numbers.
                        for line in text.split('----------------------------------------')[0].splitlines():
                            if ':' in line:
                                k, v = line.split(':', 1)
                                saved['header'][k.strip().lower().replace(' ', '_')] = v.strip()
                        text = text.split('=== HOST DETAILS ===')[0]
                    found, amenities = scan_text(text, str(path.relative_to(root)))
                    saved['permits'].extend(found)
                    saved['amenities'].update(amenities)
                    header = re.search(r'(?<!\d)(\d+)\+?\s+guests?\s*[·•|]\s*(\d+)\s+bedrooms?\b', text, re.I)
                    if header:
                        saved['capacity'] = {'occupancy': int(header[1]), 'bedrooms': int(header[2]), 'source': str(path.relative_to(root))}
            except (OSError, ValueError) as exc:
                warnings.append(f'{lid}: {exc}; will retry on next scan')
                saved = old if old else saved
                saved['signature'] = None
            cache[lid] = saved
        # Local metadata is a newer, richer source; empty values never erase data.
        for source, values in [('details header', saved.get('header', {})), ('metadata', saved.get('metadata', {}))]:
            for key, value in values.items():
                if value is None or value == '' or (isinstance(value, str) and value.strip().lower() in ('none', 'null', 'nan')) or key in ('listing_id', 'url'):
                    continue
                if key in ('bedrooms', 'beds', 'occupancy', 'latitude', 'longitude', 'privacy_radius_meters', 'native_radius_meters') and number(value) is None:
                    continue
                if str(row.get(key, '')) != str(value):
                    repairs.append({'listing_id': lid, 'field': key, 'before': row.get(key, ''), 'after': value, 'source': source})
                row[key] = value
        for key in ['occupancy', 'bedrooms']:
            if number(row.get(key)) is None and key in saved.get('capacity', {}):
                row[key] = saved['capacity'][key]
                repairs.append({'listing_id': lid, 'field': key, 'before': '', 'after': row[key], 'source': saved['capacity']['source']})
        row['_permits'] = saved.get('permits', [])
        row['_amenities'] = saved.get('amenities', {})
        row['_scanned'] = bool(files)
    write_json(cache_path, cache)
    return rows, repairs, warnings


def build_parcels(root, output, permits):
    from parcel_inputs import source_signature, iter_parcels
    source = source_signature(root)
    if not source:
        return {'available': False}
    active = {p['parcel'] for p in permits if p['status'] == 'current'}
    signature = [2, source, hashlib.sha256('\n'.join(sorted(active)).encode()).hexdigest()]
    manifest_path = output / 'data/parcels/manifest.json'
    if manifest_path.exists():
        existing = json.loads(manifest_path.read_text(encoding='utf-8'))
        if existing.get('signature') == signature:
            return existing
    print('Preparing parcel outlines and address tiles...', flush=True)
    tiles, licensed = defaultdict(list), []
    parcel_count = 0
    for feature in iter_parcels(root):
        parcel_count += 1
        p, geom = feature.get('properties', {}), feature.get('geometry')
        if not geom:
            continue
        coords = point(p.get('Lon'), p.get('Lat'))
        if not coords:
            continue
        parcel = str(p.get('STANPAR', ''))
        item = {'type': 'Feature', 'geometry': geom, 'properties': {'parcel': parcel, 'address': p.get('PropAddr', ''), 'owner': p.get('Owner', ''), 'current_permit': parcel in active}}
        if parcel in active:
            licensed.append(item)
        key = f'{math.floor(coords[0]*100)}_{math.floor(coords[1]*100)}'
        tiles[key].append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': coords}, 'properties': item['properties']})
    for key, features in tiles.items():
        write_json(output / f'data/parcels/{key}.json', {'type': 'FeatureCollection', 'features': features})
    write_json(output / 'data/licensed_parcels.geojson', {'type': 'FeatureCollection', 'features': licensed})
    manifest = {'available': True, 'signature': signature, 'tiles': list(tiles), 'parcel_count': parcel_count, 'licensed_parcel_count': len(licensed)}
    write_json(manifest_path, manifest)
    return manifest


def build(root=ROOT, output=None, as_of=None):
    output = output or root/'nashville_site'
    as_of = as_of or date.today()
    output.mkdir(parents=True, exist_ok=True)
    permits, by_number = load_permits(root, as_of)
    rows, repairs, warnings = collect_listings(root, root/'.nashville_cache/listing_scan.json')
    listings, evidence = [], []
    for lid, row in sorted(rows.items()):
        row['listing_id'] = lid
        found = row.pop('_permits', [])
        amenities = row.pop('_amenities', {})
        scanned = row.pop('_scanned', False)
        # Also inspect any description/registration supplied in the master CSV.
        text = '\n'.join(f'{k}: {v}' for k, v in row.items() if any(w in k.lower() for w in ['description', 'title', 'registration', 'permit', 'license', 'amenit']))
        extra, extra_amenities = scan_text(text, 'listing_details.csv / merged metadata')
        found += extra
        amenities.update(extra_amenities)
        unique = {}
        for f in found:
            unique.setdefault(f['number'], f)
        matches = {p['id']: p for key in unique for p in by_number.get(key, [])}
        states = {p['status'] for p in matches.values()}
        status = 'current' if 'current' in states else 'expired' if 'expired' in states else 'other' if matches else 'unmatched' if found else 'unknown'
        allowed, over = capacity_for_detected_licenses(row.get('bedrooms'), row.get('occupancy'), len(unique))
        for f in unique.values():
            evidence.append({'listing_id': lid, **f, 'matched_permit_ids': [p['id'] for p in by_number.get(f['number'], [])]})
        listings.append({'listing_id': lid, 'url': f'https://www.airbnb.com/rooms/{lid}',
                         'title': row.get('title', ''), 'host_name': row.get('host_name', ''),
                         'host_user_id': str(row.get('host_user_id', '')), 'host_profile_url': row.get('host_profile_url', ''),
                         'rental_type': row.get('rental_type', ''),
                         'point': point(row.get('longitude'), row.get('latitude')), 'location_name': row.get('location_name', ''),
                         'privacy_radius_meters': number(row.get('privacy_radius_meters')),
                         'bedrooms': number(row.get('bedrooms')), 'guests': number(row.get('occupancy')),
                         'allowed_guests': allowed, 'over_capacity': over, 'license_status': status,
                         'detected_permit_count': len(unique), 'dual_license_capacity': len(unique) == 2,
                         'community_license_status': row.get('community_license_status', 'undetermined'),
                         'permit_numbers': list(unique), 'permit_evidence': list(unique.values()),
                         'matched_permit_numbers': [p.get('permit_number') or p.get('id') or p.get('number') for p in matches.values() if p.get('permit_number') or p.get('id') or p.get('number')],
                         'matched_permits': list(matches.values()), 'amenities': amenities,
                         'party_house': bool(amenities), 'text_scanned': scanned or bool(text),
                         'detailed_text_scanned': scanned,
                         'scrape_status': row.get('fields_status', 'pending')})
    from prepare_addresses import annotate_parcel_addresses
    parcel_address_count = annotate_parcel_addresses(root, listings)
    parcels = build_parcels(root, output, permits)
    from prepare_spatial import annotate_spatial
    spatial = annotate_spatial(root, output, listings, permits, parcels.get('available', False))
    from prepare_nearby import build_nearby
    nearby = build_nearby(root, output, listings)
    missing_numbers = sum(not p['permit_number'] for p in permits)
    if missing_numbers:
        warnings.append(f'{missing_numbers:,} permit rows have no usable permit number. The supplied Permit # field contains addresses. Direct status matches require real permit numbers or an authoritative permit_number_crosswalk.csv.')
    stats = {'built_at': datetime.now(timezone.utc).isoformat(), 'as_of': as_of.isoformat(),
             'listings': len(listings), 'mapped_listings': sum(bool(l['point']) for l in listings),
             'text_scanned': sum(l['text_scanned'] for l in listings), 'permits': len(permits),
             'detailed_text_scanned': sum(l['detailed_text_scanned'] for l in listings),
             'listing_statuses': dict(Counter(l['license_status'] for l in listings)),
             'permit_statuses': dict(Counter(p['status'] for p in permits)),
             'listings_with_permit_numbers': sum(bool(l['permit_numbers']) for l in listings),
             'listings_with_parcel_addresses': parcel_address_count,
             'over_capacity': sum((l['over_capacity'] or 0) > 0 for l in listings),
             'party_keywords': sum(l['party_house'] for l in listings), 'repairs': len(repairs),
             'warnings': warnings, 'parcels': {k:v for k,v in parcels.items() if k not in ('signature','tiles')},
             'spatial': spatial,
             'nearby_parcels': {k:v for k,v in nearby.items() if k not in ('signature','tiles')},
             'sources': {'rules': RULES, 'permits': PORTAL}, 'scanner_version': SCANNER_VERSION}
    # Each file is replaced atomically. Manifest is written last as the rebuild signal.
    write_json(output/'data/listings.json', listings)
    write_json(output/'data/permits.json', permits)
    write_csv(output/'data/listings.csv', listings)
    write_csv(output/'data/permits.csv', permits)
    write_csv(output/'data/permit_evidence.csv', evidence, ['listing_id','number','raw','method','source','evidence','matched_permit_ids'])
    write_csv(output/'data/repair_audit.csv', repairs, ['listing_id','field','before','after','source'])
    write_csv(output/'data/listing_details_repaired.csv', list(rows.values()))
    for path in (root/'website_template').iterdir():
        if path.is_file():
            if path.suffix.lower() in {'.jpg', '.jpeg', '.png', '.webp', '.gif'}:
                atomic_bytes(output/path.name, path.read_bytes())
            else:
                atomic_text(output/path.name, path.read_text(encoding='utf-8'))
    write_json(output/'data/build_report.json', stats)
    print(f"Built {stats['mapped_listings']:,}/{len(listings):,} listings; {len(permits):,} permits; {stats['listings_with_permit_numbers']} listings with permit numbers; {len(repairs)} repaired/enriched fields.", flush=True)
    return stats


def input_signature(root):
    paths = [root/'listing_details.csv', root/'listing_urls.csv', root/'permit_number_crosswalk.csv']
    paths += list((root/'nashville_permits').glob('*.csv')) + list((root/'website_template').glob('*'))
    paths += list(root.glob('Parcels*.geojson'))
    paths += list((root/'data/parcels').glob('*.json')) + list((root/'data/parcels').glob('*.geojson'))
    paths += list((root/'geography').glob('*.geojson'))
    paths += list((root/'listing_results').glob('*/metadata.json')) + list((root/'listing_results').glob('*/details.txt'))
    return [(str(p), file_signature(p)) for p in paths if p.is_file()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--watch', action='store_true', help='Incremental scan and rebuild when inputs change')
    parser.add_argument('--interval', type=int, default=30)
    parser.add_argument('--serve', type=int, metavar='PORT')
    parser.add_argument('--output', type=Path, default=ROOT/'nashville_site')
    parser.add_argument('--as-of', type=date.fromisoformat, help='YYYY-MM-DD; defaults to local current date')
    args = parser.parse_args()
    if args.interval < 5:
        parser.error('--interval must be at least 5 seconds')
    if args.serve:
        class Handler(http.server.SimpleHTTPRequestHandler):
            def send_head(self):
                # Close Windows file handles before streaming to slow browser clients,
                # so the watcher can atomically replace generated JSON during a request.
                import io
                with FILE_IO_LOCK:
                    stream = super().send_head()
                    if stream is None:
                        return None
                    try:
                        return io.BytesIO(stream.read())
                    finally:
                        stream.close()
            def end_headers(self):
                self.send_header('Cache-Control', 'no-cache')
                super().end_headers()
            def log_message(self, *_):
                pass
        server = http.server.ThreadingHTTPServer(('127.0.0.1', args.serve), partial(Handler, directory=str(args.output)))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        print(f'Preview: http://127.0.0.1:{args.serve}', flush=True)
    previous = None
    stop_file = ROOT/'.nashville_cache/STOP'
    def heartbeat(state, **extra):
        try:
            write_json(args.output/'data/scanner_status.json', {'pid': os.getpid(), 'checked_at': datetime.now(timezone.utc).isoformat(), 'state': state, 'interval_seconds': args.interval, **extra})
        except OSError as exc:
            print(f'Heartbeat file temporarily unavailable; scanner continues: {exc}', flush=True)
    while True:
        try:
            signature = [str(args.as_of or date.today()), input_signature(ROOT)]
            if signature != previous:
                build(ROOT, args.output, args.as_of)
                previous = signature
            if not args.watch:
                break
            heartbeat('watching')
        except Exception as exc:
            if not args.watch:
                raise
            print(f'{datetime.now().isoformat()} Scan failed; retrying: {exc}', flush=True)
            heartbeat('retrying', error=str(exc))
        if stop_file.exists():
            print('STOP file found. Scanner stopped.', flush=True)
            heartbeat('stopped')
            break
        time.sleep(args.interval)
    if args.serve and not args.watch:
        print('Serving preview; press Ctrl+C to stop.', flush=True)
        threading.Event().wait()


if __name__ == '__main__':
    main()
