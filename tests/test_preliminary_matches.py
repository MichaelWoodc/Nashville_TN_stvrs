import unittest
import tempfile
import json
from pathlib import Path
from preliminary_matches import name_match, nickname_pairs, bucket, build_matches


class PreliminaryMatchTests(unittest.TestCase):
    def test_names_and_uncertainty(self):
        pairs = {('bob', 'robert'), ('robert', 'bob')}
        self.assertEqual(name_match('Bob', 'SMITH ROBERT', pairs), 'owner_nickname')
        self.assertEqual(name_match('Robert Smith', 'SMITH ROBERT', pairs), 'owner_name')
        self.assertEqual(name_match('Robert', 'SMITH ROBERT', pairs), 'owner_first_name')
        self.assertIsNone(name_match('Robert', 'ROBERT PROPERTIES LLC', pairs))
        self.assertIsNone(name_match('Bob Jones', 'ROBERT SMITH', pairs))
        self.assertIsNone(name_match('', 'ROBERT SMITH', pairs))

    def test_local_nicknames(self):
        pairs = nickname_pairs(Path(__file__).resolve().parents[1]/'nicknames-master/names.csv')
        self.assertIn(('bob', 'robert'), pairs)
        self.assertEqual(len(bucket('10405039000')), 2)

    def test_bidirectional_candidates_preserve_ambiguity(self):
        from build_nashville import write_json
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for parcel in ['A', 'B']:
                write_json(root/f'data/nearby_parcels/{parcel}.geojson', {'features':[{'properties':{'id':parcel,'parcel':parcel,'owner':'SMITH ROBERT','address':parcel+' Main St'}}]})
            write_json(root/'data/nearby_candidates/01.json', {'01':[{'id':p,'distance_m':10} for p in ['A','B']]})
            listing = {'listing_id':'01','host_name':'Robert','matched_permits':[]}
            build_matches(root, root, [listing], [])
            self.assertEqual(len(listing['preliminary_matches']), 2)
            for parcel in ['A', 'B']:
                reverse = json.loads((root/f'data/property_matches/{bucket(parcel)}.json').read_text(encoding='utf-8'))
                self.assertEqual(reverse[parcel], [{'listing_id':'01','type':'owner_first_name','distance_m':10}])
