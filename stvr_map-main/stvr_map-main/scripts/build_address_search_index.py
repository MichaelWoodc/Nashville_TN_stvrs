"""Build a small exact-address-to-tile index from the existing geography tiles."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def normalize(value):
    return ' '.join(str(value).split()).upper()

def bucket(key):
    result = 0
    for character in key:
        result = (result * 31 + ord(character)) % 256
    return f'{result:02x}'

def build_index(tile_dir=None):
    tile_dir = tile_dir or ROOT / 'data/geography_files/parcel_address_tiles'
    manifest = json.loads((tile_dir / 'manifest.json').read_text(encoding='utf-8'))
    shards = {f'{n:02x}': {} for n in range(256)}
    options = {}
    for filename in sorted(set(manifest['tiles'].values())):
        for lng, lat, address in json.loads((tile_dir / filename).read_text(encoding='utf-8')):
            full = normalize(address)
            if full:
                options.setdefault(full[0], set()).add(full)
            # Both the complete address and its exact street portion are valid keys.
            for key in {normalize(address), normalize(address.split(',')[0])} - {''}:
                shards[bucket(key)].setdefault(key, set()).add(filename)
    output = tile_dir / 'address_search'
    output.mkdir(exist_ok=True)
    for name, entries in shards.items():
        (output / f'{name}.json').write_text(json.dumps({k: sorted(v) for k, v in sorted(entries.items())}, separators=(',', ':'), ensure_ascii=False), encoding='utf-8')
    option_manifest = {}
    for first, addresses in sorted(options.items()):
        filename = f'options_{ord(first):x}.json'
        option_manifest[first] = filename
        (output / filename).write_text(json.dumps(sorted(addresses), ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    (output / 'options_manifest.json').write_text(json.dumps(option_manifest), encoding='utf-8')
    print(f'Indexed {sum(map(len, shards.values())):,} exact address keys in 256 lookup shards')

if __name__ == '__main__':
    build_index()
