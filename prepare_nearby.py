"""On-demand parcel geometry and sorted address candidates within exactly 550 m."""
import hashlib
import json
import math
from collections import defaultdict

NEARBY_VERSION = 1
RADIUS = 550


def build_nearby(root, output, listings):
    from parcel_inputs import source_signature, iter_parcels
    from build_nashville import write_json
    from shapely.geometry import Point, box, shape, mapping
    from shapely.ops import transform
    from shapely import make_valid
    from shapely.strtree import STRtree
    from pyproj import Transformer
    source = source_signature(root)
    mapped = [l for l in listings if l.get('point')]
    signature = [NEARBY_VERSION, source, hashlib.sha256(json.dumps([(l['listing_id'], l['point']) for l in mapped], separators=(',', ':')).encode()).hexdigest()]
    manifest_path = output/'data/nearby_parcels/manifest.json'
    if manifest_path.exists():
        saved = json.loads(manifest_path.read_text(encoding='utf-8'))
        if saved.get('signature') == signature:
            return saved
    if not source or not mapped:
        return {'available':False}
    print('Preparing nearby parcel geometry and 550 m address candidates...', flush=True)
    forward = Transformer.from_crs(4326,26916,always_xy=True).transform
    inverse = Transformer.from_crs(26916,4326,always_xy=True).transform
    geographic_points = [Point(l['point']) for l in mapped]
    geographic_tree = STRtree(geographic_points)
    points = [transform(forward,p) for p in geographic_points]
    point_tree = STRtree(points)
    tiles = defaultdict(list)
    candidates = {l['listing_id']:[] for l in mapped}
    total = 0
    for source_feature in iter_parcels(root):
        raw_geometry = source_feature.get('geometry')
        if not raw_geometry:
            continue
        geom = shape(raw_geometry)
        if geom.is_empty:
            continue
        x1,y1,x2,y2 = geom.bounds
        # Conservative angular bbox prefilter in the Nashville region; metric test below is authoritative.
        if not len(geographic_tree.query(box(x1-.008,y1-.008,x2+.008,y2+.008))):
            continue
        projected = transform(forward, make_valid(geom))
        nearby_indices = point_tree.query(projected, predicate='dwithin', distance=RADIUS)
        if not len(nearby_indices):
            continue
        p = source_feature['properties']
        representative = projected.representative_point()
        center = list(inverse(representative.x,representative.y))
        oid = str(p.get('OBJECTID',source_feature.get('id')))
        tile = f'{math.floor(center[0]*100)}_{math.floor(center[1]*100)}'
        feature = {'type':'Feature','id':oid,'geometry':raw_geometry,
                   'properties':{'id':oid,'parcel':str(p.get('STANPAR','')),'address':p.get('PropAddr',''),
                                 'owner':p.get('Owner',''),'point':center}}
        tiles[tile].append(feature)
        for index in nearby_indices:
            index = int(index)
            candidates[mapped[index]['listing_id']].append({'id':oid,'tile_group':tile,'distance_m':round(points[index].distance(projected),3)})
        total += 1
    tile_manifest, file_by_id = [], {}
    for key, features in tiles.items():
        # Bound every browser asset well below GitHub's per-file limit too.
        batches, batch, size = [], [], 0
        for f in features:
            encoded_size = len(json.dumps(f,ensure_ascii=False,separators=(',',':')).encode('utf-8'))
            if batch and size+encoded_size>8_000_000:
                batches.append(batch);batch=[];size=0
            batch.append(f);size+=encoded_size
        if batch:batches.append(batch)
        for i,batch in enumerate(batches):
            name = f'{key}_{i}.geojson'
            bounds = [shape(f['geometry']).bounds for f in batch]
            bbox = [min(b[0] for b in bounds),min(b[1] for b in bounds),max(b[2] for b in bounds),max(b[3] for b in bounds)]
            write_json(output/f'data/nearby_parcels/{name}',{'type':'FeatureCollection','features':batch})
            tile_manifest.append({'file':name,'bounds':bbox,'parcels':len(batch)})
            for f in batch:file_by_id[f['properties']['id']]=name
    buckets = defaultdict(dict)
    for lid, values in candidates.items():
        values.sort(key=lambda c:(c['distance_m'],c['id']))
        for candidate in values:
            candidate['tile']=file_by_id[candidate['id']]
            del candidate['tile_group']
        buckets[lid[-2:]][lid] = values
    for key,values in buckets.items():
        write_json(output/f'data/nearby_candidates/{key}.json',values)
    manifest = {'available':True,'signature':signature,'radius_m':RADIUS,'parcel_count':total,
                'listing_count':len(mapped),'candidate_count':sum(len(v) for v in candidates.values()),'tiles':tile_manifest}
    write_json(manifest_path,manifest)
    print(f'Prepared {total:,} nearby parcels in {len(tile_manifest)} tiles, with sorted candidates for {len(mapped):,} listings.',flush=True)
    return manifest
