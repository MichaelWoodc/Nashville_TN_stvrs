"""Visible Edge checks for scope and name-first candidate ordering."""
import argparse
import re
from pathlib import Path
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://127.0.0.1:8766')
args = parser.parse_args()

def assert_order(page, selector):
    rows = []
    for button in page.locator(selector+' button').all():
        text = button.inner_text()
        label = button.locator('span').first.inner_text()
        rank = 0 if label == 'License number' else 2 if label == 'Distance only' else 1
        match = re.search(r'([\d.]+) m to parcel boundary', text)
        rows.append((rank, float(match[1]) if match else float('inf')))
    assert rows, 'No candidate rows rendered'
    assert rows == sorted(rows), rows

with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=False)
    page = browser.new_page(viewport={'width':1440,'height':1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(args.url, wait_until='domcontentloaded')
    page.wait_for_function('window.nashville && nashville.map.getSource("parcels")', timeout=60000)
    if page.locator('#firstVisitDisclaimer').is_visible():
        page.locator('#dismissFirstVisit').click()
    assert page.evaluate('nashville.listings.every(l=>!l.point || l.boundary_distance_m>=-550.000001)')
    assert page.evaluate("nashville.listings.every(l=>!(/\\btiny[\\s_-]*(home|house)s?\\b/i.test(l.title+' '+l.rental_type)) || !l.likely_hotel)")
    assert page.evaluate("(()=>{const rows=[{type:'distance',distance_m:1},{type:'owner_nickname',distance_m:20},{type:'owner_name',distance_m:10},{type:'distance',distance_m:5}];return rows.sort(associationOrder).map(r=>r.distance_m).join(',')==='10,20,1,5';})()")
    page.evaluate("showListing(nashville.listings.find(l=>l.point&&l.preliminary_matches.length))")
    page.wait_for_function("document.querySelector('[data-property-associations] button')", timeout=60000)
    assert page.locator('.maplibregl-popup details[open]').count()==0
    page.locator('summary',has_text='Property / license candidates').click()
    assert_order(page, '[data-property-associations]')
    page.locator('[data-property-associations] button').first.click()
    page.wait_for_function("document.querySelector('[data-associations] button')", timeout=60000)
    assert page.locator('.maplibregl-popup details[open]').count()==0
    assert page.locator('.maplibregl-popup h3').inner_text() in ['License record','Property record']
    page.locator('summary',has_text='Possibly associated listings').click()
    assert_order(page, '[data-associations]')
    assert 'Auto matched, not verified' in page.locator('.maplibregl-popup').inner_text()
    assert page.evaluate("""async()=>{
      const permit=nashville.permits.find(p=>p.point&&licensedParcels.features.some(f=>normalizeParcel(f.properties.parcel)===normalizeParcel(p.parcel)));
      const property=licensedParcels.features.find(f=>normalizeParcel(f.properties.parcel)===normalizeParcel(permit.parcel)).properties;
      await showProperty(permit,permit.point);
      const fromPermit=popup.getElement().textContent.split('Possibly associated listings')[0];
      await showProperty(property,permit.point);
      return fromPermit===popup.getElement().textContent.split('Possibly associated listings')[0];
    }""")
    assert not errors, errors
    output = Path(__file__).resolve().parents[1]/'.nashville_cache/validation/scope-association-order.png'
    output.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(output))
    print('Visible Edge passed: city scope, tiny homes, and both candidate list orders.')
    browser.close()
