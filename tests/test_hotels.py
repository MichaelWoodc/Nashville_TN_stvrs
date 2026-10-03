import unittest
from hotel_classification import classify_hotel

class HotelTests(unittest.TestCase):
    def test_tiny_homes_override_hotel_evidence(self):
        for row in [{'rental_type':'Tiny home','host_name':'Hilton'}, {'property_type':'TINY_HOUSE','room_type':'Hotel room'}, {'title':'Tiny homes in SoBro','host_name':'AvantStay Nashville'}, {'title':'Tiny-house near a hotel'}]:
            with self.subTest(row=row):
                self.assertEqual(classify_hotel(row), {'likely_hotel':False,'hotel_evidence':[]})
    def test_sources(self):
        for row in [{'room_type':'Hotel room'}, {'rental_type':'Room in boutique hotel'}, {'title':'Wyndham Nashville 2 bedroom condo'}, {'host_name':'AvantStay Nashville Hotels'}, {'description':'Welcome to Club Wyndham Nashville.'}, {'title':'Studio 154 Luxury Suite'}, {'description':'Our boutique hotel offers king rooms.'}]:
            with self.subTest(row=row): self.assertTrue(classify_hotel(row)['likely_hotel'])
    def test_nearby_and_comparisons(self):
        for text in ['Home near Wyndham Nashville', 'Better than a hotel', 'Walkable Group Condo, Resort Pool', 'Boutique Hotel Vibes - 3 Lux Kings', 'The McGavock Loft - Near Gaylord Opryland Hotel', 'Horse Hotel Nashville', 'Elvis Heartbreak Hotel on Music Row', 'Walk to the Hilton hotel', 'Our home is minutes from the hotel']:
            with self.subTest(text=text): self.assertFalse(classify_hotel({'title':text})['likely_hotel'])
    def test_host_identity_not_propagated(self):
        self.assertFalse(classify_hotel({'host_name':'AvantStay', 'title':'Private home'})['likely_hotel'])

    def test_narrative_false_positives(self):
        for text in ['The accommodations are similar to a hotel room', 'White Limozeen at The Graduate Hotel', 'Our Florida resort and beautiful Nashville homes offer it all', 'There is a bar area that has a hotel like set up', 'Day-pass access at the Dive Motel pool']:
            with self.subTest(text=text): self.assertFalse(classify_hotel({'description':text})['likely_hotel'])

    def test_inn_default_and_guest_override(self):
        row={'title':'Country Inn Steeped in History/Hachland- Poplar #4'}
        self.assertTrue(classify_hotel(row)['likely_hotel'])
        self.assertTrue(classify_hotel({'description':'An INN with historic rooms'})['likely_hotel'])
        self.assertFalse(classify_hotel({'title':'Winning dinner retreat'})['likely_hotel'])
        self.assertFalse(classify_hotel(row, not_hotel_tips=[{'address':'5396 RAWLINGS RD'}])['likely_hotel'])
        self.assertTrue(classify_hotel({**row,'room_type':'Hotel room'}, not_hotel_tips=[{'address':'test'}])['likely_hotel'])
        self.assertFalse(classify_hotel({**row,'rental_type':'Tiny home'})['likely_hotel'])
