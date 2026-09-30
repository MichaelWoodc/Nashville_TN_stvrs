"""Visible Edge validation of hotel screening and counts."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
with sync_playwright() as p:
    browser=p.chromium.launch(channel='msedge',headless=False)
    page=browser.new_page(viewport={'width':1440,'height':1000})
    errors=[]
    page.on('pageerror',lambda e: errors.append(str(e)))
    page.goto('http://127.0.0.1:8765',wait_until='domcontentloaded')
    page.wait_for_function('window.nashville && nashville.map.loaded()',timeout=90000)
    page.evaluate("document.querySelector('#firstVisitDisclaimer').close()")
    state=page.evaluate('''() => {
      const hotels=nashville.listings.filter(l=>l.likely_hotel);
      const cell={type:'Feature',geometry:{type:'Polygon',coordinates:[]},properties:{cell_id:'0_0',center:[0,0]}};
      const sample={listing_id:'hotel',likely_hotel:true,point:[0,0],cell_id:'0_0',boundary_distance_m:10,privacy_radius_meters:10,nearest_licensed_parcel_m:100};
      const cells=Spatial.balanceCells([sample,{...sample,listing_id:'home',likely_hotel:false}],[],[cell],0);
      return {hotels:hotels.length,orange:hotels.every(l=>nashville.markerColor(l)==='#f97316'),warnings:hotels.filter(nashville.likelyUnlicensed).length,syntheticWarning:Spatial.likelyUnlicensed(sample,10,0),cellListings:cells[0].properties.listings,footer:document.querySelector('#hotelCount').textContent,revenue:document.querySelector('#revenueEquation').textContent};
    }''')
    assert state['hotels']>400,state
    assert state['orange'] and not state['warnings'] and not state['syntheticWarning'],state
    assert state['cellListings']==1,state
    assert f"{state['hotels']:,}" in state['footer'],state
    assert 'likely hotels excluded' in state['revenue'],state
    page.evaluate("nashville.showListing(nashville.listings.find(l=>l.likely_hotel&&l.point&&l.title.includes('Wyndham')))")
    page.wait_for_timeout(1000)
    assert 'Likely hotel' in page.locator('.maplibregl-popup').inner_text()
    out=ROOT/'.nashville_cache/validation';out.mkdir(exist_ok=True)
    page.screenshot(path=str(out/'hotels-desktop.png'))
    page.set_viewport_size({'width':390,'height':844})
    page.screenshot(path=str(out/'hotels-mobile.png'))
    assert not errors,errors
    print(json.dumps(state,ensure_ascii=True))
    browser.close()
