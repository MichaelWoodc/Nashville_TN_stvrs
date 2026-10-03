"""Evidence-based hotel screening; never a determination of permit compliance."""
import re
import unicodedata

SOURCES = [
    'https://www.visitmusiccity.com/sites/default/files/2025-04/2025-DowntownMidtownHotelMap.pdf',
    'https://www.visitmusiccity.com/plan-a-trip-to-nashville/places-to-stay',
    'https://www.placemakr.com/locations/nashville',
    'https://avantstay.com/hotels/nashville',
    'https://thedivemotel.com/',
]
# Specific names avoid matching ordinary words such as dream, graduate or courtyard.
BRANDS = r'wyndham|marriott|hilton|hyatt|sheraton|westin|doubletree|hampton inn|homewood suites|home2 suites|embassy suites|holiday inn|staybridge suites|candlewood suites|residence inn|springhill suites|towneplace suites|fairfield inn|la\s*quinta|best western|comfort inn|comfort suites|quality inn|sleep inn|days inn|super 8|red roof inn|extended stay america|drury|moxy|aloft|kimpton|loews|margaritaville|gaylord opryland|bluegreen|placemakr|mint house|sonder|ac hotel|cambria hotel|omni nashville|conrad nashville|four seasons|renaissance nashville|w nashville'
LOCAL = r'hermitage hotel|bobby hotel|the nash hotel|fairlane hotel|noelle nashville|dream nashville|holston house|hutton hotel|hotel fraye|hayes street hotel|capitol hotel|bankers alley hotel|countrypolitan|thompson nashville|virgin hotels?|graduate nashville|aertson hotel|maxwell house hotel|studio 154|bode nashville|the joseph|union station hotel|union station nashville|printing house hotel|songteller hotel|motif on music row|the russell hotel|the gallatin hotel|the iris motel|the dive motel|the gilmore|the outrider|the carter|the nomad'
NAME = re.compile(r'\b(?:' + BRANDS + '|' + LOCAL + r')\b', re.I)
HOTEL = re.compile(r'\b(?:hotels?|aparthotel|apart-hotel|boutique hotel|motel|resort)\b', re.I)
CONTEXT = re.compile(r'\b(?:near(?:by)?|close to|next to|across from|from|away|walk to|minutes? to|miles? to|visit|unlike|better than|instead of|not (?:a|an)|(?:hotel|resort)[- ](?:style|quality|vibes|like)|similar to|your dream|comforts of home|elevation of a hotel|expecting|hotel room experience|like a hotel|conference|day.pass|limozeen|florida|resort[- ](?:pool|amenities|living|vibes)|horse hotel|heartbreak hotel)\b', re.I)

def classify_hotel(row, reports=None, not_hotel_tips=None):
    # Explicit accommodation identity wins over hotel branding or comparisons.
    for field in ('rental_type', 'property_type', 'room_type', 'accommodation_type', 'title', 'name'):
        if re.search(r'\btiny[\s_-]*(?:home|house)s?\b', str(row.get(field, '')), re.I):
            return {'likely_hotel': False, 'hotel_evidence': []}
    explicit_room = any(re.search(r'\bhotel[ _-]*room\b|\broom in (?:a |boutique )?hotel\b', str(row.get(k, '')), re.I) for k in ('rental_type', 'room_type', 'property_type', 'accommodation_type'))
    if not_hotel_tips and not explicit_room:
        return {'likely_hotel': False, 'hotel_evidence': [], 'hotel_source': 'user_submitted_not_hotel'}
    if reports:
        return {'likely_hotel':True, 'hotel_evidence':[{'field':r['source'], 'rule':'hotel_submission', 'evidence':r.get('hotel_name') or 'User submitted hotel identification', **r} for r in reports], 'hotel_reports':reports, 'hotel_source':'user_submitted' if any(r['source']=='user_submitted' for r in reports) else 'manual'}
    evidence = []
    for field, raw in row.items():
        key = field.lower().replace(' ', '_')
        if key not in ('title', 'name', 'rental_type', 'property_type', 'room_type', 'accommodation_type', 'location_name', '_hotel_text') and 'description' not in key:
            continue
        text = unicodedata.normalize('NFKC', str(raw or '')).split('=== HOST DETAILS ===')[0]
        match = re.search(r'\binn\b', text, re.I)
        if match:
            evidence.append({'field': field, 'match': match.group(), 'rule': 'inn_default', 'evidence': 'Inn mentioned in listing; default hotel classification. ' + text[max(0, match.start()-80):match.end()+120].strip()})
            break
    # User-supplied override: AvantStay Nashville listings mentioning SoBro.
    # Do not use the host biography, which can describe unrelated properties.
    host = ' '.join(str(row.get('host_name', '')).split()).casefold()
    if host == 'avantstay nashville':
        for field, raw in row.items():
            key = field.lower().replace(' ', '_')
            if key not in ('title', 'name', 'rental_type', 'property_type', 'room_type', 'location_name', '_hotel_text') and 'description' not in key:
                continue
            text = unicodedata.normalize('NFKC', str(raw or '')).split('=== HOST DETAILS ===')[0]
            match = re.search(r'\bsobro\b', text, re.I)
            if match:
                evidence.append({'field': field, 'match': match.group(),
                                 'rule': 'manual_avantstay_nashville_sobro',
                                 'evidence': 'User override: AvantStay Nashville + SoBro. ' + text[max(0, match.start()-80):match.end()+120].strip()})
                break
    for field, raw in row.items():
        key = field.lower().replace(' ', '_')
        is_type = key in ('room_type', 'rental_type', 'property_type', 'accommodation_type')
        is_identity = key in ('title', 'name', 'host_name')
        if not (is_type or is_identity or 'description' in key or key in ('host_details', '_hotel_text')):
            continue
        text = unicodedata.normalize('NFKC', str(raw or ''))
        for sentence in re.split(r'[\n.!?;]+', text):
            match = NAME.search(sentence) or HOTEL.search(sentence)
            if not match:
                continue
            if not is_type and CONTEXT.search(sentence[max(0, match.start()-65):match.end()+30]):
                continue
            # Narrative mentions must identify the accommodation, not a local attraction.
            if not (is_type or is_identity) and not re.search(
                r'\b(?:welcome to|stay at|staying at|located (?:at|in)|our (?:(?:boutique|luxury|apartment) )?(?:hotel|resort|property)|this (?:hotel|resort)|hotel (?:room|guest)|resort (?:offers|features)|(?:this property|this building|we) (?:is|are) (?:a|an) .{0,25}(?:hotel|resort)|managed by|operated by)\b', sentence, re.I):
                continue
            evidence.append({'field': field, 'match': match.group(), 'evidence': sentence.strip()[:450]})
            break
    return {'likely_hotel': bool(evidence), 'hotel_evidence': evidence}
