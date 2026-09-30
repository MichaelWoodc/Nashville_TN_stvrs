"""Assign listing points to parcel addresses from the local parcel source."""
import hashlib
import json

ADDRESS_VERSION = 1


def annotate_parcel_addresses(root, listings):
    from build_nashville import write_json
    from parcel_inputs import iter_parcels, source_signature

    mapped = [listing for listing in listings if listing.get('point')]
    for listing in listings:
        listing['approximate_address'] = ''
    source = source_signature(root)
    if not source or not mapped:
        return 0

    point_signature = hashlib.sha256(json.dumps(
        [(listing['listing_id'], listing['point']) for listing in mapped],
        separators=(',', ':')).encode()).hexdigest()
    signature = [ADDRESS_VERSION, source, point_signature]
    cache_path = root/'.nashville_cache/parcel_addresses.json'
    try:
        cached = json.loads(cache_path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        cached = {}
    if cached.get('signature') == signature:
        addresses = cached.get('addresses', {})
    else:
        from pyproj import Transformer
        from shapely.geometry import Point, shape
        from shapely.ops import transform
        from shapely.strtree import STRtree

        forward = Transformer.from_crs(4326, 26916, always_xy=True).transform
        geographic_points = [Point(listing['point']) for listing in mapped]
        projected_points = [transform(forward, point) for point in geographic_points]
        geographic_tree = STRtree(geographic_points)
        projected_tree = STRtree(projected_points)
        winners = {}
        for parcel_feature in iter_parcels(root):
            raw_geometry = parcel_feature.get('geometry')
            if not raw_geometry:
                continue
            geographic_geometry = shape(raw_geometry)
            if geographic_geometry.is_empty or not len(geographic_tree.query(geographic_geometry)):
                continue
            parcel_geometry = transform(forward, geographic_geometry)
            property_data = parcel_feature.get('properties', {})
            address = str(property_data.get('PropAddr') or '').strip()
            if not address:
                continue
            for index in projected_tree.query(parcel_geometry, predicate='intersects'):
                point = projected_points[int(index)]
                if not parcel_geometry.covers(point):
                    continue
                parcel_id = str(property_data.get('STANPAR') or '')
                candidate = (parcel_geometry.area, parcel_id, address)
                winner = winners.get(int(index))
                if winner is None or candidate < winner:
                    winners[int(index)] = candidate
        addresses = {listing['listing_id']: winners[index][2]
                     for index, listing in enumerate(mapped) if index in winners}
        write_json(cache_path, {'signature': signature, 'addresses': addresses})

    for listing in mapped:
        listing['approximate_address'] = addresses.get(listing['listing_id'], '')
    return sum(bool(listing['approximate_address']) for listing in mapped)
