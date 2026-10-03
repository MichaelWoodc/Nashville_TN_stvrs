"""Preserve but exclude listings beyond the map boundary's 550 m outer buffer."""
import json
import shutil


def partition_city_rows(root, output, rows):
    from build_nashville import point, write_json
    from shapely.geometry import Point, shape
    from shapely.ops import transform, unary_union
    from pyproj import Transformer
    boundary_path = root/'geography/davidson_county.geojson'
    if not boundary_path.exists():
        return rows, 0
    project = Transformer.from_crs(4326, 26916, always_xy=True).transform
    boundary = unary_union([transform(project, shape(f['geometry'])) for f in json.loads(boundary_path.read_text(encoding='utf-8'))['features']])
    retained, excluded = {}, []
    archive = root/'listing_results/outside_city_550m'
    resolved_root = root.resolve()
    for lid, row in rows.items():
        coords = point(row.get('longitude'), row.get('latitude'))
        distance = transform(project, Point(coords)).distance(boundary) if coords else None
        if distance is None or distance <= 550 + 1e-6:
            retained[lid] = row
            continue
        excluded.append({**{k:v for k,v in row.items() if not k.startswith('_')}, 'listing_id':lid, 'outside_boundary_m':round(distance, 3)})
        source, target = root/'listing_results'/lid, archive/lid
        if source.exists():
            if not source.resolve().is_relative_to(resolved_root) or not archive.resolve().is_relative_to(resolved_root) or not target.resolve().is_relative_to(archive.resolve()):
                raise ValueError('Listing archive path outside intended workspace')
            if target.exists():
                raise FileExistsError(f'Archive already exists; source preserved: {target}')
            archive.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), str(target))
    # Bound archive data files below GitHub limits; original folders stay intact.
    parts = []
    for i in range(0, len(excluded), 250):
        name = f'listings_{i//250:03}.json'
        write_json(output/f'data/outside_city_550m/{name}', excluded[i:i+250])
        parts.append(name)
    write_json(output/'data/outside_city_550m/manifest.json', {'count':len(excluded), 'parts':parts, 'boundary':'geography/davidson_county.geojson', 'outside_buffer_m':550, 'missing_coordinates':'retained, location undetermined'})
    print(f'City scope: retained {len(retained):,}; archived {len(excluded):,} listings beyond 550 m outside the boundary.', flush=True)
    return retained, len(excluded)
