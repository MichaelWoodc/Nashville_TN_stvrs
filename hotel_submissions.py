"""Local hotel overrides and read-only public form responses, with cached recovery."""
import csv
import io
import json
import re
import time
from collections import defaultdict
from urllib.request import urlopen

SHEET = 'https://docs.google.com/spreadsheets/d/1ImiJ2rtbhon5-vOfh3AiifrBd6b3tAsIVeW7bnTm8P0/edit'
EXPORT = SHEET.replace('/edit', '/export?format=csv')
FORM = 'https://docs.google.com/forms/d/e/1FAIpQLScjN7eHKBjY3c8Iew6F08WYgHN30ozXlv9NHg2lpfBrABGXdg/viewform'


def ids(value):
    return list(dict.fromkeys(re.findall(r'(?:https?://)?(?:www\.)?airbnb\.com/rooms/(\d+)', str(value or ''), re.I)))


def refresh_public(root, force=False):
    from build_nashville import write_json
    config = root/'hotel_sources.json'
    if not config.exists():
        return []
    settings = json.loads(config.read_text(encoding='utf-8'))
    if not settings.get('enabled', True):
        return []
    cache = root/'.nashville_cache/hotel_submissions.json'
    try:
        saved = json.loads(cache.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        saved = {}
    if not force and time.time()-saved.get('checked_at', 0)<settings.get('refresh_seconds', 300):
        return saved.get('rows', [])
    try:
        with urlopen(settings.get('csv_url', EXPORT), timeout=15) as response:
            text = response.read(5_000_001).decode('utf-8-sig')
        if len(text)>5_000_000 or 'Airbnb.com listing' not in text.splitlines()[0]:
            raise ValueError('Unexpected hotel response CSV; cached responses retained')
        rows = list(csv.DictReader(io.StringIO(text)))
        saved = {'checked_at':time.time(), 'rows':rows, 'source_url':SHEET}
        write_json(cache, saved)
    except Exception as exc:
        print(f'Hotel submissions refresh failed; using cached responses: {exc}', flush=True)
        saved['checked_at'] = time.time()
        write_json(cache, saved)
    return saved.get('rows', [])


def load_hotels(root):
    from build_nashville import read_csv
    registry = defaultdict(list)
    for row in read_csv(root/'hotels.csv'):
        for lid in ids(row.get('url', '')):
            registry[lid].append({'source':'manual', 'hotel_name':row.get('hotel_name',''), 'proof_url':row.get('proof_url',''), 'address':row.get('address',''), 'notes':row.get('notes','')})
    for row in refresh_public(root):
        for lid in ids(row.get('Airbnb.com listing', '')):
            registry[lid].append({'source':'user_submitted', 'hotel_name':'', 'proof_url':row.get('Hotel Proof URL',''), 'address':row.get('Address',''), 'source_url':SHEET})
    return registry
