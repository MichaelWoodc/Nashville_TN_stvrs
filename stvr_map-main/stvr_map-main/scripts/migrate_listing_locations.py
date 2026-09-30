from pathlib import Path
import argparse, json, re

ROOT = Path(__file__).resolve().parents[1]
RENAMES = {'latitude': 'airbnb_latitude', 'longitude': 'airbnb_longitude', 'approximate_address': 'airbnb_approximate_address'}

def migrate(path, check=False):
    text = path.read_text(encoding='utf-8-sig')
    match = re.search(r'(?:const|let|var)\s+\w+\s*=\s*(?=\[)', text)
    if not match:
        raise ValueError(f'{path}: no listing array found')
    start = match.end()
    records, end = json.JSONDecoder().raw_decode(text[start:])
    changed = False
    for index, record in enumerate(records):
        for old, new in RENAMES.items():
            if old in record:
                if new in record and record[new] != record[old]:
                    raise ValueError(f'{path}: conflicting {old}/{new} for {record.get("url")}')
                changed = True
        record = {RENAMES.get(key, key): value for key, value in record.items()}
        records[index] = record
        for name in ('actual_latitude', 'actual_longitude', 'actual_address'):
            if name not in record:
                record[name] = None
                changed = True
    if changed and not check:
        # Preserve any JavaScript following the data array, including occupancy corrections.
        indentation = re.search(r'\n( +)\{', text[start:])
        indent = len(indentation[1]) if indentation else 2
        output = text[:start] + json.dumps(records, ensure_ascii=False, indent=indent, allow_nan=False) + text[start+end:]
        temporary = path.with_suffix(path.suffix + '.tmp')
        temporary.write_text(output, encoding='utf-8', newline='\n')
        temporary.replace(path)
    return len(records), changed

def main():
    parser = argparse.ArgumentParser(description='Rename approximate listing fields and add empty confirmed-location fields. Safe to rerun; license fields and existing actual locations are preserved.')
    parser.add_argument('files', nargs='*', type=Path)
    parser.add_argument('--check', action='store_true', help='Report pending migrations without writing')
    args = parser.parse_args()
    paths = args.files or sorted(p for p in ROOT.rglob('*.js') if p.name.startswith(('locations', 'unincorporated_locations')))
    for path in paths:
        count, changed = migrate(path, args.check)
        print(f'{path.relative_to(ROOT) if path.is_relative_to(ROOT) else path}: {count} listings; {"migration needed" if args.check and changed else "updated" if changed else "already current"}')

if __name__ == '__main__':
    main()
