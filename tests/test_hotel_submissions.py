import tempfile
import unittest
from pathlib import Path
from hotel_submissions import ids, load_hotels
from hotel_classification import classify_hotel


class HotelSubmissionTests(unittest.TestCase):
    def test_url_identity_and_manual_overrides(self):
        self.assertEqual(ids('https://www.airbnb.com/rooms/123?foo=1\nairbnb.com/rooms/123'), ['123'])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'hotels.csv').write_text('url,hotel_name,proof_url,address,notes\nhttps://www.airbnb.com/rooms/123,Example hotel,https://example.org/proof,123 Main St,\n', encoding='utf-8')
            reports = load_hotels(root)['123']
            result = classify_hotel({'title':'Ordinary title'}, reports)
            self.assertTrue(result['likely_hotel'])
            self.assertEqual(result['hotel_source'], 'manual')
            self.assertEqual(result['hotel_reports'][0]['proof_url'], 'https://example.org/proof')
            self.assertFalse(classify_hotel({'rental_type':'Tiny home'}, reports)['likely_hotel'])

    def test_public_response_provenance(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch('hotel_submissions.refresh_public', return_value=[{'Airbnb.com listing':'airbnb.com/rooms/456','Hotel Proof URL':'https://example.org/proof','Address':'Reported address'}]):
                result = classify_hotel({}, load_hotels(root)['456'])
                self.assertEqual(result['hotel_source'], 'user_submitted')
                self.assertEqual(result['hotel_reports'][0]['address'], 'Reported address')
