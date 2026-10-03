"""Unverified associations using direct nickname edges and nearby parcel boundaries."""
import csv
import hashlib
import json
import re
import unicodedata
from collections import defaultdict


def tokens(value):
    value = ''.join(c for c in unicodedata.normalize('NFKD', str(value or '').lower()) if not unicodedata.combining(c))
    return re.findall(r'[a-z]+', value)


def nickname_pairs(path):
    pairs = set()
    if path.exists():
        with path.open(encoding='utf-8-sig') as stream:
            for row in csv.DictReader(stream):
                a, b = row['name1'], row['name2']
                pairs.update([(a, b), (b, a)])
    return pairs


def name_match(host, owner, pairs):
    h, o = tokens(host), tokens(owner)
    corporate = {'llc', 'inc', 'trust', 'properties', 'rentals', 'management', 'company', 'corp'}
    if not h or not o or set(o) & corporate:
        return None
    if h == o or (len(h) > 1 and set(h).issubset(o)):
        return 'owner_name'
    # A first name alone is weak evidence and is explicitly labeled as such.
    if len(h) == 1 and h[0] in o:
        return 'owner_first_name'
    if any((a, b) in pairs for a in h for b in o):
        if len(h) == 1 or any(a in o for a in h):
            return 'owner_nickname'
    return None


def bucket(parcel):
    return hashlib.sha256(str(parcel).encode()).hexdigest()[:2]


def build_matches(root, output, listings, permits):
    from build_nashville import write_json
    pairs = nickname_pairs(root/'nicknames-master/names.csv')
    name_cache = {}
    def classify(host, owner):
        key = (str(host or ''), str(owner or ''))
        if key not in name_cache:
            name_cache[key] = name_match(host, owner, pairs)
        return name_cache[key]
    properties, refs = {}, {}
    for path in (output/'data/nearby_parcels').glob('*.geojson'):
        for f in json.loads(path.read_text(encoding='utf-8'))['features']:
            properties[str(f['properties']['id'])] = f['properties']
    for path in (output/'data/nearby_candidates').glob('*.json'):
        refs.update(json.loads(path.read_text(encoding='utf-8')))
    by_parcel = defaultdict(list)
    for p in permits:
        by_parcel[re.sub(r'[^0-9A-Za-z]', '', p['parcel'])].append(p)
    reverse = defaultdict(list)
    for listing in listings:
        matches = []
        for p in listing['matched_permits']:
            matches.append({'type':'license_number', 'permit_id':p['id'], 'parcel':p['parcel'], 'address':p['address'], 'owner':p['owner'], 'distance_m':None})
        for ref in refs.get(listing['listing_id'], []):
            p = properties.get(ref['id'])
            if not p:
                continue
            licenses = by_parcel.get(re.sub(r'[^0-9A-Za-z]', '', p['parcel']), [])
            kind = classify(listing['host_name'], p['owner'])
            for license in licenses:
                license_kind = classify(listing['host_name'], license['owner'])
                if license_kind:
                    kind = 'permit_' + license_kind
                    break
            match = {'type':kind or 'distance', 'parcel':p['parcel'], 'address':p['address'], 'owner':p['owner'], 'distance_m':ref['distance_m'], 'permit_ids':[v['id'] for v in licenses]}
            matches.append(match)
        matches.sort(key=lambda m:(m['type']=='distance', m['distance_m'] if m['distance_m'] is not None else -1, m['parcel']))
        listing['preliminary_matches'] = [m for m in matches if m['type'] != 'distance']
        # Distance candidates stay in the existing nearby files; reverse index is sharded.
        for m in matches:
            if m['parcel']:
                reverse[m['parcel']].append({'listing_id':listing['listing_id'], 'type':m['type'], 'distance_m':m['distance_m']})
    shards = defaultdict(dict)
    for parcel, values in reverse.items():
        values.sort(key=lambda m:(0 if m['type']=='license_number' else 2 if m['type']=='distance' else 1, m['distance_m'] if m['distance_m'] is not None else float('inf'), m['listing_id']))
        shards[bucket(parcel)][parcel] = values
    for key, values in shards.items():
        write_json(output/f'data/property_matches/{key}.json', values)
    write_json(output/'data/property_matches/manifest.json', {'buckets':sorted(shards), 'verified':False, 'radius_m':550, 'nickname_source':'nicknames-master/names.csv'})
