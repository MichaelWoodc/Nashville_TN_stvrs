"""Regression checks for capacities, evidence extraction, and status preservation."""
import csv
import json
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_nashville import capacity, capacity_for_detected_licenses, extract_permits, permit_key, permit_status, scan_text, load_permits, collect_listings, build, input_signature
from prepare_spatial import circle_overlaps_parcel, signed_edge_distance
from prepare_addresses import annotate_parcel_addresses


class BuildTests(unittest.TestCase):
    def test_capacity_examples_and_unknowns(self):
        self.assertEqual(capacity(6, 16), (12, 4))
        self.assertEqual(capacity(3, 12), (10, 2))
        self.assertEqual(capacity(0, 6), (4, 2))
        self.assertEqual(capacity(None, 8), (None, None))
        self.assertEqual(capacity(None, 16), (None, 4))
        self.assertEqual(capacity(2, None), (8, None))
        self.assertEqual(capacity_for_detected_licenses(3,16,2),(14,2))
        self.assertEqual(capacity_for_detected_licenses(16,30,2),(24,6))
        self.assertEqual(capacity_for_detected_licenses(None,25,2),(None,1))
        self.assertEqual(capacity_for_detected_licenses(3,16,3),(10,6))

    def test_permit_normalization_and_evidence(self):
        for text, expected in [('Permit #2019017225','2019017225'),('Registration Details\n2023081409','2023081409'),('STR Permit: T2023058559','2023058559'),('Permit: CASR 2015_followed by_17031','2015017031'),('PERMIT: 2022followedby024folllowedby213','2022024213')]:
            self.assertIn(expected, [r['number'] for r in extract_permits(text,'fixture')])
        self.assertEqual(permit_key('1414A LILLIAN ST, NASHVILLE, TN, 37206'),'')
        self.assertEqual(extract_permits('Host ID 2023081409','fixture'),[])
        self.assertEqual(extract_permits('Listing 12023081409999999','fixture'),[])

    def test_party_word_boundaries(self):
        _, amen = scan_text('Pool table, hottub, jacuzzi, bar. Barbara loves barbecue.','test')
        self.assertEqual(set(amen), {'pool_table','hot_tub','bar'})
        self.assertEqual(scan_text('Barbara has a barbecue','test')[1],{})
        self.assertIn('pool', scan_text('Swimming pool and pool table','test')[1])
        self.assertIn('karaoke', scan_text('Bring your KARAOKE-loving friends','test')[1])
        bachelor=scan_text('Bachelor weekend in Nashville','test')[1]
        bachelorette=scan_text('Bachelorette party downtown','test')[1]
        self.assertIn('bachelor_party',bachelor)
        self.assertIn('bachelorette_party',bachelorette)

    def test_parcel_geometry_overlap_not_permit_centroid(self):
        from shapely.geometry import Point, Polygon, box
        parcel = box(0, 0, 100, 100)
        self.assertTrue(circle_overlaps_parcel(Point(99, 50).distance(parcel), 0))
        self.assertFalse(circle_overlaps_parcel(Point(210, 50).distance(parcel), 100, 0))
        self.assertTrue(circle_overlaps_parcel(Point(210, 50).distance(parcel), 100, 10))
        # A polygon's hole is not part of a licensed plot.
        donut = Polygon([(0,0),(100,0),(100,100),(0,100)], holes=[[(25,25),(75,25),(75,75),(25,75)]])
        self.assertFalse(circle_overlaps_parcel(Point(50,50).distance(donut), 20, 10))
        self.assertTrue(circle_overlaps_parcel(Point(50,50).distance(donut), 25, 0))
        self.assertIsNone(circle_overlaps_parcel(100, None))
        self.assertIsNone(circle_overlaps_parcel(None, 500))

    def test_signed_edge_buffer(self):
        from shapely.geometry import Point, box
        boundary = box(0, 0, 1000, 1000)
        self.assertEqual(signed_edge_distance(Point(20,500),boundary),20)
        self.assertEqual(signed_edge_distance(Point(-20,500),boundary),-20)
        self.assertGreaterEqual(signed_edge_distance(Point(-20,500),boundary), -50)
        self.assertLess(signed_edge_distance(Point(20,500),boundary), 50)

    def test_listing_receives_containing_parcel_address(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            parcel={'type':'Feature','properties':{'STANPAR':'12345678900','PropAddr':'42 TEST ST'},
                    'geometry':{'type':'Polygon','coordinates':[[[-86.781,36.162],[-86.780,36.162],[-86.780,36.163],[-86.781,36.163],[-86.781,36.162]]]}}
            (root/'Parcels_fixture.geojson').write_text(json.dumps({'type':'FeatureCollection','features':[parcel]}),encoding='utf-8')
            listings=[{'listing_id':'123','point':[-86.7805,36.1625]}]
            self.assertEqual(annotate_parcel_addresses(root,listings),1)
            self.assertEqual(listings[0]['approximate_address'],'42 TEST ST')

    def test_expired_and_other_statuses(self):
        today=date(2026,9,29)
        self.assertEqual(permit_status('ISSUED','9/28/2026 12:00:00 AM',today),'expired')
        self.assertEqual(permit_status('ISSUED','9/29/2026 12:00:00 AM',today),'current')
        self.assertEqual(permit_status('EXPIRED','',today),'expired')
        self.assertEqual(permit_status('CANCELLED','1/1/2020',today),'cancelled')

    def test_full_id_and_metadata_repair_without_changing_source(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); lid='1011324912190135766'; folder=root/'listing_results'/lid; folder.mkdir(parents=True)
            source='listing_id,url,bedrooms,occupancy\n1.01132491219014E+18,https://www.airbnb.com/rooms/'+lid+',,8\n'
            (root/'listing_details.csv').write_text(source)
            (folder/'metadata.json').write_text(json.dumps({'bedrooms':3,'occupancy':None,'permit_number':'2023081409'}))
            rows,repairs,_=collect_listings(root,root/'cache.json')
            self.assertIn(lid,rows);self.assertEqual(rows[lid]['bedrooms'],3);self.assertEqual(rows[lid]['occupancy'],'8')
            self.assertEqual((root/'listing_details.csv').read_text(),source)
            self.assertTrue(repairs)
            self.assertEqual(rows[lid]['_permits'][0]['number'],'2023081409')

    def test_crosswalk_matches_expired_and_cancelled(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'nashville_permits').mkdir()
            (root/'nashville_permits/nashville_permits.csv').write_text('ObjectId,Permit #,Permit Status\n1,123 TEST ST,EXPIRED\n2,456 TEST ST,CANCELLED\n')
            (root/'permit_number_crosswalk.csv').write_text('object_id,permit_number,source_url\n1,2023081409,https://example.org/official\n2,2023081409,https://example.org/official\n')
            _,index=load_permits(root,date(2026,9,29))
            self.assertEqual({p['status'] for p in index['2023081409']},{'expired','cancelled'})

    def test_incremental_rebuild_and_new_listing(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); (root/'nashville_permits').mkdir(); (root/'website_template').mkdir()
            (root/'website_template/index.html').write_text('<html>fixture</html>')
            folder=root/'listing_results/123';folder.mkdir(parents=True)
            path=folder/'metadata.json'
            path.write_text(json.dumps({'bedrooms':3,'occupancy':12,'latitude':36.16,'longitude':-86.78,'description':'Pool table. Permit #2023000001'}))
            (root/'nashville_permits/nashville_permits.csv').write_text('ObjectId,Permit #,Permit Status\n1,CASR2023000001,EXPIRED\n')
            before=input_signature(root)
            build(root)
            first=json.loads((root/'nashville_site/data/listings.json').read_text())
            self.assertEqual(first[0]['license_status'],'expired')
            self.assertEqual(first[0]['community_license_status'],'undetermined')
            self.assertEqual(first[0]['over_capacity'],2)
            self.assertEqual(first[0]['matched_permits'][0]['source_status'],'EXPIRED')
            path.write_text(json.dumps({'bedrooms':6,'occupancy':16,'latitude':36.16,'longitude':-86.78,'description':'A hot tub'}))
            new=root/'listing_results/456';new.mkdir();(new/'metadata.json').write_text(json.dumps({'bedrooms':2,'occupancy':8}))
            self.assertNotEqual(before,input_signature(root))
            build(root)
            second=json.loads((root/'nashville_site/data/listings.json').read_text())
            self.assertEqual(len(second),2)
            self.assertEqual(second[0]['over_capacity'],4)
            self.assertEqual(second[0]['permit_numbers'],[])
            self.assertEqual(set(second[0]['amenities']),{'hot_tub'})


if __name__ == '__main__':
    unittest.main()
