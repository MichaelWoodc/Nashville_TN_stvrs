"""Visible Edge regression for rental type checkboxes and empty host combinations."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.nashville_cache/validation';OUT.mkdir(exist_ok=True)
COMBO='bachelor_party|bachelorette_party|hot_tub|pool|pool_table'
with sync_playwright() as p:
 browser=p.chromium.launch(channel='msedge',headless=False)
 page=browser.new_page(viewport={'width':1440,'height':1000})
 errors=[];tile_zooms=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.on('request',lambda r:tile_zooms.append(int(r.url.split('/')[3])) if 'tile.openstreetmap.org/' in r.url else None)
 page.goto('http://127.0.0.1:8765',wait_until='domcontentloaded')
 page.wait_for_function('window.nashville && nashville.map.loaded()',timeout=90000)
 if page.locator('#firstVisitDisclaimer').is_visible():page.locator('#dismissFirstVisit').click()
 assert not page.locator('#rentalTypes').evaluate('(el)=>el.open')
 assert page.locator('#rentalTypeHint').inner_text()=='Click to expand'
 page.locator('#rentalTypes summary').click()
 page.wait_for_function("document.querySelector('#rentalTypeHint').textContent==='Click to hide'")
 count=page.locator('.rental-type').count()
 assert count>10
 page.locator('#rentalTypesNone').click()
 assert page.evaluate('nashville.visible.length')==0
 for t in ['Entire home','Room in hotel']:
  page.locator(f'.rental-type[value="{t}"]').check()
 state=page.evaluate("({types:[...new Set(nashville.visible.map(l=>l.rental_type))],count:nashville.visible.length})")
 assert set(state['types'])=={'Entire home','Room in hotel'} and state['count']>0,state
 # New data must preserve checkbox selections and event delegation.
 page.evaluate('reloadData()')
 page.wait_for_function('window.nashville && nashville.map.loaded()')
 assert page.locator('.rental-type:checked').count()==2
 page.locator('.rental-type[value="Room in hotel"]').uncheck()
 assert page.evaluate("nashville.visible.every(l=>l.rental_type==='Entire home')")
 page.screenshot(path=str(OUT/'rental-types-desktop.png'))
 page.locator('#reset').click()
 assert page.locator('.rental-type:checked').count()==count
 # Reproduce the exact reported combination, with and without the capacity requirement.
 for required in [False,True]:
  page.evaluate('resetExploreFilters()')
  page.locator('.hosts summary').click() if not page.locator('.hosts details').evaluate('(el)=>el.open') else None
  page.locator('#hostSearch').fill('Host Extraordinaires')
  row=page.locator('.host-row').filter(has=page.locator('.host-name',has_text='Host Extraordinaires'))
  assert row.count()==1
  row.locator('.host-metric').last.click()
  page.locator('#closePartyDisclaimer').click()
  if required:page.locator('.host-capacity-filter').filter(has_text='Require over capacity').locator('input').check()
  page.locator(f'.host-combo[data-combo="{COMBO}"]').click()
  assert page.evaluate('nashville.visible.length')==0
  assert page.locator('.host-combos').is_visible()
  assert page.locator('.host-capacity-filter').filter(has_text='Require over capacity').locator('input').is_checked()==required
  assert 'outside' in page.locator('.host-capacity-note').inner_text()
  assert page.locator(f'.host-combo[data-combo="{COMBO}"]').get_attribute('aria-pressed')=='true'
  page.screenshot(path=str(OUT/f'host-empty-capacity-{required}.png'))
  page.locator('.show-outside-host').click()
  assert page.evaluate('nashville.visible.length')==1
  assert page.evaluate("nashville.visible[0].listing_id")=='1461614775877853675'
  assert page.locator('.host-combos').is_visible()
 # Raster source should overzoom existing tiles instead of requesting zoom 20+.
 page.evaluate('nashville.map.jumpTo({zoom:20})')
 page.wait_for_timeout(1500)
 assert page.evaluate("nashville.map.getSource('osm').maxzoom")==19
 assert max(tile_zooms)<=19,tile_zooms
 page.set_viewport_size({'width':390,'height':844})
 page.locator('.hosts summary').click() if not page.locator('.hosts details').evaluate('(el)=>el.open') else None
 assert page.locator('.host-combos').is_visible()
 page.screenshot(path=str(OUT/'host-combos-mobile.png'))
 assert not errors,errors
 print(json.dumps({'rental_types':count,'multi_select':state,'host_combination':'retained with and without capacity requirement','maximum_requested_tile_zoom':max(tile_zooms),'errors':errors}))
 browser.close()
