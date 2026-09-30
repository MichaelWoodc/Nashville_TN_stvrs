"""Lossless, GitHub-safe parcel source chunks and a shared streaming reader."""
from __future__ import annotations
import argparse
import hashlib
import json
import shutil
from pathlib import Path

CHUNK_BYTES = 20_000_000


def source_paths(root):
    manifest = root/'data/parcels/manifest.json'
    if manifest.exists():
        data = json.loads(manifest.read_text(encoding='utf-8'))
        return [manifest.parent/p['file'] for p in data['parts']]
    return sorted(root.glob('Parcels*.geojson'))[:1]


def source_signature(root):
    return [[str(p.relative_to(root)), p.stat().st_size, p.stat().st_mtime_ns] for p in source_paths(root)]


def iter_parcels(root):
    for path in source_paths(root):
        with path.open(encoding='utf-8-sig') as stream:
            data = json.load(stream)
        yield from data['features']


def split_source(root, archive_original=False):
    from build_nashville import write_json
    sources = sorted(root.glob('Parcels*.geojson'))
    if not sources:
        if source_paths(root):
            print('Parcel chunks already present; no unsplit source found.')
            return
        raise FileNotFoundError('No parcel GeoJSON found')
    source = sources[0]
    target = root/'data/parcels'
    target.mkdir(parents=True, exist_ok=True)
    with source.open(encoding='utf-8-sig') as stream:
        data = json.load(stream)
    prefix = b'{"type":"FeatureCollection","features":['
    suffix = b']}'
    parts, current, size = [], [], len(prefix)+len(suffix)
    digest = hashlib.sha256()
    def flush():
        nonlocal current, size
        if not current:
            return
        name = f'parcels_{len(parts)+1:03}.geojson'
        content = prefix+b','.join(current)+suffix
        (target/name).write_bytes(content)
        parts.append({'file': name, 'features': len(current), 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()})
        current, size = [], len(prefix)+len(suffix)
    for feature in data['features']:
        encoded = json.dumps(feature, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
        if len(encoded)+len(prefix)+len(suffix)>CHUNK_BYTES:
            raise ValueError('A single parcel exceeds the chunk target; source retained')
        if size+len(encoded)+1>CHUNK_BYTES:
            flush()
        current.append(encoded);size+=len(encoded)+1;digest.update(encoded+b'\n')
    flush()
    check = hashlib.sha256();count=0
    for part in parts:
        for feature in json.loads((target/part['file']).read_text(encoding='utf-8'))['features']:
            check.update(json.dumps(feature, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')+b'\n')
            count += 1
    if count != len(data['features']) or check.hexdigest() != digest.hexdigest():
        raise ValueError('Chunk verification failed; original retained')
    write_json(target/'manifest.json', {'type': 'parcel_source_chunks', 'feature_count': count,
               'feature_sequence_sha256': check.hexdigest(), 'original_filename': source.name,
               'target_bytes': CHUNK_BYTES, 'parts': parts})
    if archive_original:
        archive = root/'.nashville_cache/original_parcels'/source.name
        resolved_root = root.resolve()
        if not source.resolve().is_relative_to(resolved_root) or not archive.resolve().is_relative_to(resolved_root):
            raise ValueError('Archive paths must remain inside this project')
        if archive.exists():
            raise FileExistsError(f'Archive exists; original not moved: {archive}')
        archive.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(source), str(archive))
    print(f'Verified {count:,} parcels in {len(parts)} lossless chunks; largest {max(p["bytes"] for p in parts):,} bytes.', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive-original', action='store_true')
    args = parser.parse_args()
    split_source(Path(__file__).resolve().parent, args.archive_original)
