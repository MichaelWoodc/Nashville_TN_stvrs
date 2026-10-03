import json
import tempfile
import unittest
from pathlib import Path
from pyproj import Transformer
from shapely.geometry import box, mapping
from shapely.ops import transform
from city_scope import partition_city_rows


class CityScopeTests(unittest.TestCase):
    def test_outer_buffer_and_archive_preservation(self):
        from build_nashville import write_json
        inverse = Transformer.from_crs(26916,4326,always_xy=True).transform
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_json(root/'geography/davidson_county.geojson', {'features':[{'geometry':mapping(transform(inverse,box(500000,4000000,501000,4001000)))}]})
            rows = {}
            for lid, x in [('1',500500), ('2',501550), ('3',501551)]:
                lon, lat = inverse(x,4000500)
                rows[lid] = {'longitude':lon,'latitude':lat}
                path = root/'listing_results'/lid/'metadata.json'
                write_json(path, rows[lid])
            rows['4'] = {}
            kept, count = partition_city_rows(root,root/'site',rows)
            self.assertEqual(set(kept), {'1','2','4'})
            self.assertEqual(count,1)
            self.assertTrue((root/'listing_results/outside_city_550m/3/metadata.json').exists())
            self.assertFalse((root/'listing_results/3').exists())
            self.assertEqual(partition_city_rows(root,root/'site',rows)[1],1)
