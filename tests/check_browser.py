"""Visible Edge smoke test against the local preview, including synthetic status fixtures."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / '.nashville_cache/validation'
ARTIFACTS.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=False)
    page = browser.new_page(viewport={'width':1440,'height':1000},device_scale_factor=1)
    errors=[]
    page.on('response', lambda r: errors.append(f'HTTP {r.status}: {r.url}') if r.status >= 400 else None)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://127.0.0.1:8765', wait_until='networkidle', timeout=90000)
    page.wait_for_function('window.nashville && window.nashville.map.loaded()', timeout=90000)
    page.screenshot(path=str(ARTIFACTS/'desktop.png'))
    state=page.evaluate('''() => ({visible:nashville.visible.length,privacy:nashville.map.getSource('privacy')._data.features.length,parcels:nashville.map.getPaintProperty('parcel-fill','fill-color'),center:nashville.map.getCenter(),canvas:nashville.map.getCanvas().width})''')
    assert state['visible']>5000,state
    assert state['privacy']>2000,state
    assert state['parcels']=='#22c55e',state
    assert page.evaluate("nashville.map.getSource('coverage')._data.features.length") == 0
    assert page.locator('.advanced #coverage').count()==1
    assert page.evaluate("nashville.map.getSource('boundary')._data.features.length") == 1
    pure=page.evaluate('''() => {
      const l={privacy_radius_meters:100,nearest_licensed_parcel_m:110,boundary_distance_m:20};
      const missing={...l,privacy_radius_meters:null};
      const cells=[{type:'Feature',geometry:{type:'Polygon',coordinates:[]},properties:{cell_id:'a',center:[0,0]}}];
      const ls=[{listing_id:'1',point:[0,0],cell_id:'a',boundary_distance_m:10},{listing_id:'2',point:[0,0],cell_id:'a',boundary_distance_m:10}];
      const ps=[{id:'p',point:[0,0],cell_id:'a',boundary_distance_m:10,status:'current'},{id:'q',point:[0,0],cell_id:'a',boundary_distance_m:10,status:'expired'}];
      return {zero:Spatial.overlap(l,0),ten:Spatial.overlap(l,10),missing:Spatial.overlap(missing,10),negative:Spatial.inScope(l,-50),positive:Spatial.inScope({...l,boundary_distance_m:-20},50),balance:Spatial.balanceCells([...ls,ls[0]],ps,cells,0)[0].properties};
    }''')
    assert pure['zero'] is False and pure['ten'] is True and pure['missing'] is None,pure
    assert pure['negative'] is False and pure['positive'] is True,pure
    assert pure['balance']['difference']==1 and pure['balance']['listings']==2,pure
    baseline=page.evaluate('nashville.visible.length')
    warning10=page.evaluate('nashville.listings.filter(l=>nashville.likelyUnlicensed(l)).length')
    page.evaluate("document.getElementById('leeway').value=0;document.getElementById('leeway').dispatchEvent(new Event('change'))")
    page.wait_for_timeout(800)
    warning0=page.evaluate('nashville.listings.filter(l=>nashville.likelyUnlicensed(l)).length')
    assert warning10 <= warning0
    page.evaluate("document.getElementById('leeway').value=10;document.getElementById('leeway').dispatchEvent(new Event('change'))")
    page.wait_for_timeout(800)
    assert page.evaluate("nashville.map.getSource('privacy')._data.features.some(f=>f.properties.radius_m===550)")
    page.check('#likely');page.wait_for_timeout(800)
    assert page.evaluate('nashville.visible.length')==warning10
    assert page.evaluate('nashville.visible.every(l=>nashville.likelyUnlicensed(l))')
    page.uncheck('#likely')
    page.evaluate("document.getElementById('edgeBuffer').value=1000;document.getElementById('edgeBuffer').dispatchEvent(new Event('change'))")
    page.wait_for_timeout(800)
    assert page.evaluate('nashville.visible.length')>=baseline
    assert page.evaluate("nashville.map.getSource('edge-buffer')._data.features[0].properties.edge_buffer_m")==1000
    page.evaluate("document.getElementById('edgeBuffer').value=-1000;document.getElementById('edgeBuffer').dispatchEvent(new Event('change'))")
    page.wait_for_timeout(800)
    assert page.evaluate('nashville.visible.length')<=baseline
    page.click('#reset');page.wait_for_timeout(800)
    page.check('#difference');page.check('#surplusHeatmap');page.wait_for_timeout(800)
    counts=page.evaluate('''() => ({total:nashville.balance.reduce((n,f)=>n+f.properties.listings,0),valid:nashville.balance.every(f=>f.properties.difference===f.properties.listings-f.properties.permits),heat:nashville.map.getSource('surplus')._data.features.every(f=>f.properties.difference>0),features:nashville.map.getSource('surplus')._data.features.length})''')
    assert counts['total']==baseline and counts['valid'] and counts['heat'] and counts['features']>0,counts
    page.click('#fitArea');page.wait_for_timeout(1800);page.screenshot(path=str(ARTIFACTS/'difference-outline.png'))
    page.click('#reset');page.wait_for_timeout(800)
    page.check('.amenity[value="karaoke"]');page.wait_for_timeout(800)
    assert page.evaluate('nashville.visible.length')>0
    assert page.evaluate('nashville.visible.every(l=>!!l.amenities.karaoke)')
    page.check('#symbols')
    page.evaluate('''() => {const l=nashville.visible[0];nashville.map.jumpTo({center:l.point,zoom:16});nashville.showListing(l);}''');page.wait_for_timeout(1000)
    assert '🎤' in page.locator('.maplibregl-popup-content').inner_text()
    assert '🎤' in ''.join(page.locator('.emoji-marker').all_text_contents())
    page.screenshot(path=str(ARTIFACTS/'karaoke.png'))
    page.locator('.maplibregl-popup-close-button').click();page.click('#reset');page.wait_for_timeout(800)
    # Real listing with 3 bedrooms and more than 10 guests.
    real=page.evaluate('''() => {const l=nashville.listings.find(l=>l.bedrooms===3 && l.guests>10 && l.point);nashville.map.jumpTo({center:l.point,zoom:16});nashville.showListing(l);return l;}''')
    assert real['allowed_guests']==10 and real['over_capacity']==real['guests']-10,real
    page.wait_for_timeout(1000)
    assert page.evaluate("nashville.map.queryRenderedFeatures({layers:['listing-labels']}).length") > 0
    assert 'Capacity: 10 guests' in page.locator('.maplibregl-popup-content').inner_text()
    page.screenshot(path=str(ARTIFACTS/'capacity-popup.png'))
    page.locator('.maplibregl-popup-close-button').click()
    page.fill('#over','2');page.locator('#over').press('Tab')
    page.wait_for_timeout(900)
    assert page.evaluate('nashville.visible.every(l=>l.over_capacity>=2)')
    page.check('.amenity[value="hot_tub"]');page.wait_for_timeout(900)
    assert page.evaluate('nashville.visible.every(l=>!!l.amenities.hot_tub)')
    page.click('#reset');page.wait_for_timeout(900)
    page.uncheck('#privacy');page.wait_for_timeout(900)
    assert page.evaluate("nashville.map.getSource('privacy')._data.features.length") == 0
    page.check('#privacy');page.wait_for_timeout(900)
    page.uncheck('#parcels');page.wait_for_timeout(900)
    assert page.evaluate("nashville.map.getLayoutProperty('parcel-fill','visibility')")=='none'
    page.check('#parcels')
    page.check('#addresses');page.wait_for_timeout(1500)
    # Expired permit fixture proves yellow + overage label even when source numbers are unavailable.
    fixture=page.evaluate('''() => {const l=structuredClone(nashville.listings.find(l=>l.point));Object.assign(l,{listing_id:'test-expired',title:'TEST fixture — expired and over capacity',point:[-86.78,36.16],displayPoint:[-86.78,36.16],boundary_distance_m:1000,guests:16,bedrooms:6,allowed_guests:12,over_capacity:4,license_status:'expired',permit_numbers:['2023000001'],matched_permits:[{id:'test',permit_number:'2023000001',status:'expired',source_status:'EXPIRED',expiration:'1/1/2025',address:'TEST ONLY',point:[-86.78,36.16],source_url:'https://epermits.nashville.gov'}]});nashville.listings.push(l);nashville.update();nashville.map.jumpTo({center:l.point,zoom:16});nashville.showListing(l);const f=nashville.map.getSource('listings')._data.features.find(f=>f.properties.id==='test-expired');return f.properties;}''')
    assert fixture['color']=='#facc15' and fixture['label']=='16\n+4',fixture
    page.wait_for_timeout(1000);page.screenshot(path=str(ARTIFACTS/'expired-fixture.png'))
    page.locator('.maplibregl-popup-close-button').click()
    page.wait_for_timeout(500)
    page.screenshot(path=str(ARTIFACTS/'expired-marker.png'),clip={'x':640,'y':430,'width':160,'height':180})
    page.reload(wait_until='networkidle');page.wait_for_function('window.nashville && nashville.map.loaded()')
    page.evaluate('''() => {const l=nashville.listings.find(l=>l.point&&l.amenities.hot_tub);nashville.map.jumpTo({center:l.point,zoom:16});}''');page.wait_for_timeout(1200)
    page.check('#symbols');page.wait_for_timeout(1000)
    assert page.locator('.emoji-marker').count()>0
    page.uncheck('#symbols');page.wait_for_timeout(800);assert page.locator('.emoji-marker').count()==0
    page.check('#symbols')
    page.set_viewport_size({'width':390,'height':844});page.click('#toggleFilters');page.wait_for_timeout(900);page.screenshot(path=str(ARTIFACTS/'mobile.png'))
    page.goto('http://127.0.0.1:8765/records.html',wait_until='networkidle');page.wait_for_function("document.querySelector('#count').textContent.includes('records')")
    assert page.locator('tbody tr').count()==100
    page.select_option('#kind','permits');assert '17,592' in page.locator('#count').inner_text()
    page.goto('http://127.0.0.1:8765/about_data.html',wait_until='networkidle')
    assert 'Hochatown' not in page.locator('body').inner_text()
    assert 'Chatham' not in page.locator('body').inner_text()
    (ARTIFACTS/'browser_results.json').write_text(json.dumps({'state':state,'errors':errors,'expired_fixture':fixture},indent=2))
    assert not errors,errors
    print(json.dumps({'state':state,'page_errors':errors,'screenshots':str(ARTIFACTS)},indent=2))
    browser.close()
