"""Visible Edge checks: occupancy math, drilldowns and listing-anchored heatmap."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.nashville_cache/validation';OUT.mkdir(exist_ok=True)
with sync_playwright() as p:
    browser=p.chromium.launch(channel='msedge',headless=False)
    page=browser.new_page(viewport={'width':1440,'height':1000})
    errors=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto('http://127.0.0.1:8765',wait_until='domcontentloaded')
    page.wait_for_function('window.nashville && nashville.map.loaded()',timeout=90000)
    if page.locator('#firstVisitDisclaimer').is_visible():page.locator('#dismissFirstVisit').click()
    pure=page.evaluate('''() => {
      const base={bedrooms:3,over_capacity:2,permit_numbers:[],detected_permit_count:0};
      const rows=[{...base,listing_id:'over'},{...base,listing_id:'ok',over_capacity:0},
        {...base,listing_id:'hotel',likely_hotel:true},{...base,listing_id:'large',bedrooms:6},
        {...base,listing_id:'multi',permit_numbers:['1','2']},{...base,listing_id:'both',bedrooms:6,detected_permit_count:2},
        {...base,listing_id:'unknown',over_capacity:null},{...base,listing_id:'over'}];
      return {defaults:ViolationStats.summarize(rows),all:ViolationStats.summarize(rows,false,false),
        empty:ViolationStats.summarize([]),duplicates:ViolationStats.licenseCount({permit_numbers:['1','1']})};
    }''')
    assert pure['defaults']==dict(total=7,hotels=1,large=2,multiple=1,unknown=1,eligible=2,over=1,percent=50),pure
    assert pure['all']['eligible']==5 and pure['all']['over']==4 and pure['all']['percent']==80,pure
    assert pure['empty']['percent'] is None and pure['duplicates']==1,pure
    expected=page.evaluate('''() => {
      const ls=nashville.listings.filter(l=>l.point&&l.boundary_distance_m>=0&&!l.likely_hotel&&!(l.bedrooms>5)&&Math.max(l.detected_permit_count||0,new Set(l.permit_numbers||[]).size)<=1&&typeof l.over_capacity==='number'&&Number.isFinite(l.over_capacity));
      const over=ls.filter(l=>l.over_capacity>=1).length;
      return {eligible:ls.length,over,percent:(100*over/ls.length).toFixed(1)};
    }''')
    assert expected['percent'] in page.locator('#violationStatsButton').inner_text()
    page.locator('#violationStatsButton').click()
    assert page.locator('#statsExcludeLarge').is_checked() and page.locator('#statsExcludeMultiple').is_checked()
    equation=page.locator('#occupancyEquation').inner_text()
    assert f"{expected['eligible']:,}" in equation and f"{expected['over']:,}" in equation,equation
    page.locator('#statsExcludeLarge').uncheck()
    page.wait_for_function("document.querySelector('#includeLargeOverCapacity').checked")
    page.locator('#statsExcludeMultiple').uncheck()
    page.wait_for_function("!document.querySelector('#excludeMultipleOverCapacity').checked")
    page.locator('#statsExcludeLarge').check();page.locator('#statsExcludeMultiple').check()
    page.wait_for_function("!document.querySelector('#includeLargeOverCapacity').checked && document.querySelector('#excludeMultipleOverCapacity').checked")
    page.screenshot(path=str(OUT/'violation-stats-desktop.png'))
    # Seed unrelated filters; drilldown must clear them and show exactly the numerator.
    page.evaluate("document.querySelector('#search').value='impossible-filter';document.querySelector('#nearOnly').checked=true")
    page.locator('#showOverOccupancy').click()
    page.wait_for_function("document.querySelector('#over').value==='1'")
    occupancy=page.evaluate('''() => ({visible:nashville.visible.length,all:nashville.visible.every(l=>!l.likely_hotel&&!(l.bedrooms>5)&&l.detected_permit_count<=1&&l.over_capacity>=1),search:document.querySelector('#search').value})''')
    assert occupancy['visible']==expected['over'] and occupancy['all'] and not occupancy['search'],occupancy
    page.locator('#potentialRevenueButton').click();page.locator('#revenueLikelyStats').click()
    assert page.locator('#violationStatsDialog').is_visible() and not page.locator('#revenueDialog').is_visible()
    page.locator('#showLikelyUnlicensed').click()
    page.wait_for_function("document.querySelector('#likely').checked && document.querySelector('#surplusHeatmap').checked")
    heat=page.evaluate('''() => {
      const fs=nashville.map.getSource('surplus')._data.features;
      const byId=new Map(nashville.visible.map(l=>[l.listing_id,l]));
      return {visible:nashville.visible.length,seeds:fs.length,all:nashville.visible.every(nashville.likelyUnlicensed),
        anchored:fs.every(f=>{const l=byId.get(f.properties.id);return l&&!l.likely_hotel&&JSON.stringify(f.geometry.coordinates)===JSON.stringify(l.displayPoint||l.point)&&f.properties.weight===1}),
        opacity:nashville.map.getPaintProperty('surplus-heatmap','heatmap-opacity'),radius:document.querySelector('#heatRadius').value,
        layer:nashville.map.getLayoutProperty('surplus-heatmap','visibility'),over:document.querySelector('#over').value};
    }''')
    assert heat['visible']==heat['seeds'] and heat['visible']>0 and heat['all'] and heat['anchored'],heat
    assert heat['opacity']==.45 and heat['radius']=='250' and heat['layer']=='visible' and heat['over']=='0',heat
    page.evaluate("nashville.map.jumpTo({center:[-86.78,36.16],zoom:12})")
    page.wait_for_timeout(1800)
    page.screenshot(path=str(OUT/'likely-heatmap-desktop.png'))
    # Filter changes must change heat seeds too, without changing the footer statistic.
    page.evaluate("document.querySelector('#search').value='no-such-listing-987654';nashville.update()")
    assert page.evaluate("nashville.map.getSource('surplus')._data.features.length")==0
    assert expected['percent'] in page.locator('#violationStatsButton').inner_text()
    page.evaluate("document.querySelector('#search').value='';nashville.update()")
    for width in [390,768,1280,1440]:
        page.set_viewport_size({'width':width,'height':900})
        page.wait_for_timeout(250)
        bounds=page.evaluate('''() => {const footer=document.querySelector('#statusbar'),map=document.querySelector('#map').getBoundingClientRect();return {overflow:footer.scrollWidth>footer.clientWidth+1,overlap:map.bottom>footer.getBoundingClientRect().top+1};}''')
        assert not bounds['overflow'] and not bounds['overlap'],(width,bounds)
    page.set_viewport_size({'width':390,'height':844})
    page.locator('#violationStatsButton').click()
    page.screenshot(path=str(OUT/'violation-stats-mobile.png'))
    page.locator('#closeViolationStats').click()
    page.screenshot(path=str(OUT/'likely-heatmap-mobile.png'))
    assert not errors,errors
    print(json.dumps({'occupancy':expected,'heatmap':heat,'errors':errors}))
    browser.close()
