'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const collection = features => ({type:'FeatureCollection', features});
const feature = (geometry, properties={}) => ({type:'Feature', geometry, properties});
const icons = {pool:'🩱',hot_tub:'👙',bar:'🍻',pool_table:'🎱',karaoke:'🎤'};
const statusNames = {current:'Current permit number matched',expired:'Expired permit number matched',other:'Other permit status matched',unmatched:'Number found · no permit data match',unknown:'No permit number found · status undetermined'};
let listings=[], permits=[], report, visible=[], selectedHost='', map, popup, emojiMarkers=[], refreshTimer;
const permitGrid = new Map(), addressCache = new Map();
let currentPermits=[], parcelManifest, addressRequest=0;
let spatial={available:false}, balance=[], balanceKey=null;
let selectedListing=null;
const leeway = () => Number($('leeway').value);
const edgeBuffer = () => Number($('edgeBuffer').value);
const parcelTolerance = () => $('nearTolerance').checked?9.144:0;
const likelyUnlicensed = l => spatial.available && Spatial.likelyUnlicensed(l,leeway(),edgeBuffer(),parcelTolerance());

function ring(point, meters, steps=40) {
  const [lon,lat]=point, angular=meters/6371008.8, phi=lat*Math.PI/180, lambda=lon*Math.PI/180;
  const coordinates=[];
  for(let i=0;i<=steps;i++) {
    const bearing=i/steps*2*Math.PI;
    const p=Math.asin(Math.sin(phi)*Math.cos(angular)+Math.cos(phi)*Math.sin(angular)*Math.cos(bearing));
    const l=lambda+Math.atan2(Math.sin(bearing)*Math.sin(angular)*Math.cos(phi),Math.cos(angular)-Math.sin(phi)*Math.sin(p));
    coordinates.push([l*180/Math.PI,p*180/Math.PI]);
  }
  return {type:'Polygon',coordinates:[coordinates]};
}
function distance(a,b) {
  const rad=Math.PI/180,dLat=(b[1]-a[1])*rad,dLon=(b[0]-a[0])*rad;
  const s=Math.sin(dLat/2)**2+Math.cos(a[1]*rad)*Math.cos(b[1]*rad)*Math.sin(dLon/2)**2;
  return 12742017.6*Math.asin(Math.min(1,Math.sqrt(s)));
}
function outsideCoverage(item, meters) {
  const [x,y]=item.point, dx=meters/(111000*Math.cos(y*Math.PI/180)),dy=meters/111000;
  for(let ix=Math.floor((x-dx)*100);ix<=Math.floor((x+dx)*100);ix++)
    for(let iy=Math.floor((y-dy)*100);iy<=Math.floor((y+dy)*100);iy++)
      for(const permit of permitGrid.get(`${ix}_${iy}`)||[]) if(distance(item.point,permit.point)<=meters) return false;
  return true;
}
function hostKey(l) { return l.host_user_id || `name:${l.host_name || '(unknown)'}`; }
function filterListings() {
  const query=$('search').value.trim().toLowerCase(), selected=[...document.querySelectorAll('.amenity:checked')].map(e=>e.value);
  const minimum=Number($('over').value), radius=Number($('radius').value);
  return listings.filter(l=>l.point && (!query||l.search.includes(query)) && (!selectedHost||hostKey(l)===selectedHost)
    && (!$('scopeOnly').checked||Spatial.inScope(l,edgeBuffer()))
    && (!$('likely').checked||likelyUnlicensed(l))
    && (!$('nearOnly').checked||(typeof l.nearest_licensed_parcel_m==='number'&&l.nearest_licensed_parcel_m<=9.144))
    && ($('status').value==='all'||l.license_status===$('status').value)
    && (!minimum||(l.over_capacity!==null&&l.over_capacity>=minimum))
    && (!$('partyOnly').checked||l.party_house)
    && (!selected.length||($('allAmenities').checked?selected.every(k=>l.amenities[k]):selected.some(k=>l.amenities[k])))
    && (!$('rentalType').value||l.rental_type===$('rentalType').value)
    && (!$('outside').checked||outsideCoverage(l,radius)));
}
function markerColor(l) {
  if(l.license_status==='expired') return '#facc15';
  if(l.license_status==='current') return '#22c55e';
  if((l.over_capacity||0)>0) return '#fb7185';
  if(l.license_status==='other') return '#c4b5fd';
  return '#e2e8f0';
}
function listingFeature(l) {
  return feature({type:'Point',coordinates:l.displayPoint||l.point},{id:l.listing_id,color:markerColor(l),warning:!!likelyUnlicensed(l),
    stroke:(l.over_capacity||0)>0?'#dc2626':'#2563eb',
    label:(l.guests===null?'?':String(l.guests))+((l.over_capacity||0)>0?'\n+'+l.over_capacity:'')});
}
function sourceData(id,data) { map.getSource(id)?.setData(data); }
function layerVisibility(ids,on) { for(const id of ids) if(map.getLayer(id)) map.setLayoutProperty(id,'visibility',on?'visible':'none'); }
function updatePrivacy() {
  const subjects=selectedListing?[selectedListing]:visible;
  sourceData('privacy',collection($('privacy').checked?subjects.filter(l=>l.privacy_radius_meters>0||l===selectedListing).map(l=>{const radius=l.privacy_radius_meters>0?l.privacy_radius_meters:15;return feature(ring(l.point,radius),{id:l.listing_id,radius_m:radius,radius_source:l.privacy_radius_meters>0?'scraped':'display_fallback'});}):[]));
  if(map.getLayer('privacy-line')){map.setPaintProperty('privacy-line','line-opacity',selectedListing?.8:.23);map.setPaintProperty('privacy-line','line-width',selectedListing?2:1);}
}

function update() {
  if(!map?.getSource('listings')) return;
  visible=filterListings();
  sourceData('listings',collection(visible.map(listingFeature)));
  if(selectedListing&&!visible.some(l=>l.listing_id===selectedListing.listing_id)){popup?.remove();selectedListing=null;}
  updatePrivacy();
  $('leewayValue').textContent=`+${leeway()}%`;
  $('edgeValue').textContent=`${edgeBuffer()>0?'+':''}${edgeBuffer()} m`;
  sourceData('edge-buffer',collection(spatial.available&&edgeBuffer()!==0?[spatial.buffers[String(edgeBuffer())]]:[]));
  sourceData('edge-band',collection(spatial.available&&edgeBuffer()!==0?[spatial.buffer_bands[String(edgeBuffer())]]:[]));
  layerVisibility(['boundary-halo','boundary-line','edge-buffer-line','edge-buffer-fill'],$ ('outline').checked);
  layerVisibility(['warning-markers'],$ ('warningSymbols').checked);
  const scoped=listings.filter(l=>l.point&&Spatial.inScope(l,edgeBuffer()));
  $('spatialSummary').textContent=spatial.available?`${scoped.filter(l=>likelyUnlicensed(l)).length.toLocaleString()} spatial warnings · ${scoped.filter(l=>Spatial.overlap(l,leeway(),parcelTolerance())===null).length} unknown · ${scoped.length.toLocaleString()} listings in analysis area. ${parcelTolerance()?'Includes 10-yard parcel tolerance (Advanced). ':''}Overlap is not a confirmed license match.`:'Spatial data unavailable; no warnings inferred.';
  updateBalance();
  layerVisibility(['parcel-fill','parcel-line'],$ ('parcels').checked);
  layerVisibility(['heatmap'],$ ('heatmap').checked);
  const displayedPermits=$('historical').checked?permits:currentPermits;
  sourceData('permit-points',collection($('permits').checked?displayedPermits.filter(p=>p.point).map(p=>feature({type:'Point',coordinates:p.point},{id:p.id,color:p.status==='current'?'#15803d':p.status==='expired'?'#eab308':'#a78bfa'})):[]));
  const radius=Number($('radius').value);
  $('radiusValue').textContent=`${radius} m`;
  sourceData('coverage',collection($('coverage').checked&&radius>0?currentPermits.map(p=>feature(ring(p.point,radius))):[]));
  $('counts').textContent=`${visible.length.toLocaleString()} visible · ${report.mapped_listings.toLocaleString()} mapped · ${(report.listings-report.mapped_listings).toLocaleString()} awaiting location`;
  updateHosts(); updateSearch(); updateSymbols(); updateAddresses();
}
function updateBalance() {
  if(!spatial.available)return;
  if(balanceKey!==edgeBuffer()) {
    balance=Spatial.balanceCells(listings,permits,spatial.cells,edgeBuffer());balanceKey=edgeBuffer();
    sourceData('balance',collection(balance));
    sourceData('surplus',collection(balance.filter(f=>f.properties.difference>0).map(f=>feature({type:'Point',coordinates:f.properties.center},f.properties))));
  }
  layerVisibility(['balance-fill','balance-outline'],$ ('difference').checked);
  layerVisibility(['surplus-heatmap'],$ ('surplusHeatmap').checked);
  const totals=balance.reduce((a,f)=>({listings:a.listings+f.properties.listings,permits:a.permits+f.properties.permits,surplus:a.surplus+Math.max(0,f.properties.difference)}),{listings:0,permits:0,surplus:0});
  $('balanceSummary').textContent=`${totals.listings.toLocaleString()} listings − ${totals.permits.toLocaleString()} current permit records. Net: ${(totals.listings-totals.permits).toLocaleString()}. Positive-cell excess: ${totals.surplus.toLocaleString()}.`;
}
function updateHosts() {
  const groups=new Map();
  for(const l of visible) {const key=hostKey(l);if(!groups.has(key))groups.set(key,{name:l.host_name||'Unknown host',items:[]});groups.get(key).items.push(l);}
  $('hostCount').textContent=`(${groups.size})`;
  $('hosts').replaceChildren();
  const heading=document.createElement('div');heading.className='host-grid host-column-labels';heading.innerHTML='<span>Host</span><span>Total</span><span>Possibly<br>unlicensed</span><span>Party<br>keywords</span>';$('hosts').append(heading);
  for(const [key,g] of [...groups].sort((a,b)=>b[1].items.length-a[1].items.length)) {
    const b=document.createElement('button');b.className='host-row host-grid'+(key===selectedHost?' selected':'');
    b.innerHTML=`<span>${esc(g.name)}</span><span>${g.items.length}</span><span>${g.items.filter(likelyUnlicensed).length}</span><span>${g.items.filter(l=>l.party_house).length}</span>`;
    b.onclick=()=>{selectedHost=key;update();fitVisible();};$('hosts').append(b);
  }
}
function updateSearch() {
  $('searchResults').replaceChildren();
  if(!$('search').value.trim()) return;
  for(const l of visible.slice(0,6)) {const b=document.createElement('button');b.className='search-result';b.textContent=l.title||l.listing_id;b.onclick=()=>{map.flyTo({center:l.point,zoom:16});showListing(l);};$('searchResults').append(b);}
}
function updateSymbols() {
  for(const marker of emojiMarkers) marker.remove(); emojiMarkers=[];
  $('symbolNote').textContent='';
  if(!$('symbols').checked) return;
  const bounds=map.getBounds(), selected=[...document.querySelectorAll('.amenity:checked')].map(e=>e.value);
  // DOM symbols only for on-screen points; map circles remain available at all zooms.
  const candidates=visible.filter(l=>l.party_house&&bounds.contains(l.displayPoint||l.point));
  const show=candidates.slice(0,600);
  if(candidates.length>600) $('symbolNote').textContent='Showing symbols for 600 on-screen listings. Zoom in or filter to see the others.';
  for(const l of show) {
    const values=['🥳',...Object.keys(l.amenities).filter(k=>!selected.length||selected.includes(k)).map(k=>icons[k]).filter(Boolean)];
    const el=document.createElement('div');el.className='emoji-marker';el.setAttribute('aria-hidden','true');
    values.forEach((icon,i)=>{const s=document.createElement('span');s.textContent=icon;const angle=-Math.PI/2+i*2*Math.PI/values.length;s.style.left=`${Math.cos(angle)*32}px`;s.style.top=`${Math.sin(angle)*32}px`;el.append(s);});
    emojiMarkers.push(new maplibregl.Marker({element:el}).setLngLat(l.displayPoint||l.point).addTo(map));
  }
  $('symbols').parentElement.title=candidates.length>600?'First 600 visible amenity markers shown; zoom in to see the rest.':'Amenity keyword symbols';
}
async function updateAddresses() {
  const request=++addressRequest;
  if(!$('addresses').checked||map.getZoom()<16||!parcelManifest?.available) {sourceData('addresses',collection([]));return;}
  const b=map.getBounds(), keys=[];
  for(let x=Math.floor(b.getWest()*100);x<=Math.floor(b.getEast()*100);x++) for(let y=Math.floor(b.getSouth()*100);y<=Math.floor(b.getNorth()*100);y++) {
    const key=`${x}_${y}`; if(parcelManifest.tiles.includes(key)) keys.push(key);
  }
  try {
    const tiles=await Promise.all(keys.map(key=>{if(!addressCache.has(key))addressCache.set(key,getJSON(`data/parcels/${key}.json`).catch(e=>{addressCache.delete(key);throw e;}));return addressCache.get(key);}));
    if(request===addressRequest) sourceData('addresses',collection(tiles.flatMap(t=>t.features)));
  }catch(e){console.error('Parcel addresses:',e);}
}
function permitCard(p) {
  return `<p><b>${esc(p.permit_number||'Permit number unavailable')}</b> <span class="badge ${esc(p.status)}">${esc(p.status)}</span><br>${esc(p.address)}<br>Source status: <b>${esc(p.source_status)}</b><br>Issued: ${esc(p.issued||'Unknown')}<br>Expires: ${esc(p.expiration||'Unknown')}<br>Parcel: ${esc(p.parcel)}<br>${esc(p.type)}<br><a href="${esc(/^https?:\/\//.test(p.source_url)?p.source_url:report.sources.permits)}" target="_blank" rel="noopener">Official permit source</a></p>`;
}
function showListing(l) {
  popup?.remove();
  selectedListing=l;updatePrivacy();
  const privacy=l.privacy_radius_meters===null?'Unknown':`${l.privacy_radius_meters} m`;
  let html=`<h3>${esc(l.title||'Airbnb listing')}</h3><span class="badge ${esc(l.license_status)}">${esc(statusNames[l.license_status])}</span><p><a href="${esc(l.url)}" target="_blank" rel="noopener">Open Airbnb listing ↗</a></p><p><b>Host:</b> ${esc(l.host_name||'Unknown')}<br><b>Guests:</b> ${esc(l.guests??'Unknown')} · <b>Bedrooms:</b> ${esc(l.bedrooms??'Unknown')}<br><b>Capacity:</b> ${esc(l.allowed_guests??"Unknown (bedrooms missing)")} guests<br><b>Over capacity:</b> ${esc(l.over_capacity??'Unknown')}${l.over_capacity>0?' guests':''}<br><b>Airbnb privacy radius:</b> ${esc(privacy)}<br><b>Approximate location:</b> ${esc(l.location_name||'Unknown')}</p>`;
  if(l.permit_numbers.length) html+=`<p><b>Permit numbers found:</b> ${l.permit_numbers.map(esc).join(', ')}</p>`;
  const overlap=Spatial.overlap(l,leeway(),parcelTolerance()), effective=Spatial.effectiveRadius(l,leeway());
  const spatialText=!spatial.available?'Spatial data unavailable':!Spatial.inScope(l,edgeBuffer())?'Outside the selected analysis area':overlap===null?'Unknown: privacy radius or parcel geometry missing':overlap?'Privacy circle reaches a green permitted parcel':'⚠️ Likely unlicensed location: privacy circle does not reach any current-permit parcel';
  html+=`<p class="${likelyUnlicensed(l)?'spatial-warning':'small'}"><b>Parcel-overlap screening:</b> ${esc(spatialText)}<br>Screening radius with +${leeway()}% leeway: ${effective===null?'Unknown':effective.toFixed(1)+' m'}<br>Extra parcel tolerance: ${parcelTolerance().toFixed(2)} m${parcelTolerance()?' (10 yards)':''}<br>Nearest permitted parcel: ${typeof l.nearest_licensed_parcel_m==='number'?l.nearest_licensed_parcel_m.toFixed(1)+' m':'Unknown'}<br><span class="small muted">${l.privacy_radius_meters>0?'The map circle uses the original scraped radius.':'The selected map circle is a 15 m display fallback; it is not a scraped radius and does not change screening.'} This geographic screen does not verify license status.</span></p>`;
  if(l.matched_permits.length) html+='<h4>Direct permit-number matches</h4>'+l.matched_permits.map(permitCard).join('');
  else html+='<p class="small muted">License status is undetermined. Geographic overlap does not establish a direct permit match.</p>';
  if(l.party_house) html+=`<p><b>🥳 Party amenity keywords:</b> ${Object.keys(l.amenities).map(k=>icons[k]).join(' ')}</p><details><summary>Amenity keyword evidence</summary>${Object.entries(l.amenities).map(([k,v])=>`<p>${icons[k]} ${esc(k.replace('_',' '))}<br><span class="evidence">${esc(v.evidence)}<br>Source: ${esc(v.source)}</span></p>`).join('')}</details>`;
  if(l.permit_evidence.length) html+=`<details><summary>Permit-number evidence</summary>${l.permit_evidence.map(e=>`<p><b>${esc(e.number)}</b> (${esc(e.method)})<br><span class="evidence">${esc(e.evidence)}<br>Source: ${esc(e.source)}</span></p>`).join('')}</details>`;
  html+='<p class="small muted">Capacity = min(2 × bedrooms + 4, 12), using advertised bedrooms. Missing bedrooms: only excess above 12 can be flagged. Saved listing data; approximate Airbnb location. <a href="about_data.html">Data and Nashville rules</a></p>';
  html+='<div class="report-actions"><button type="button" data-report="location">Report listing location</button><button type="button" data-report="license">Report matching license</button><button type="button" data-report="address">Report address</button></div>';
  popup=new maplibregl.Popup({maxWidth:'380px'}).setLngLat(l.displayPoint||l.point).setHTML(html).addTo(map);
  popup.getElement().querySelectorAll('[data-report]').forEach(button=>button.onclick=()=>Reporting.open(l,button.dataset.report));
  const links=l.matched_permits.filter(p=>p.point).map(p=>feature({type:'LineString',coordinates:[l.point,p.point]}));
  sourceData('connections',collection(links));
  popup.on('close',()=>{sourceData('connections',collection([]));if(selectedListing===l){selectedListing=null;updatePrivacy();}});
}
function fitVisible() {
  if(!visible.length)return;
  const b=new maplibregl.LngLatBounds();visible.forEach(l=>b.extend(l.point));map.fitBounds(b,{padding:60,maxZoom:16});
}
function prepareData() {
  balanceKey=null;
  currentPermits=permits.filter(p=>p.status==='current'&&p.point);permitGrid.clear();
  for(const p of currentPermits) {const key=`${Math.floor(p.point[0]*100)}_${Math.floor(p.point[1]*100)}`;if(!permitGrid.has(key))permitGrid.set(key,[]);permitGrid.get(key).push(p);}
  const groups=new Map();
  for(const l of listings) {
    l.search=JSON.stringify(l).toLowerCase();
    if(l.point){const key=l.point.join(',');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(l);}
  }
  // Preserve true positions/radii; only spread stacked clickable marker centers.
  for(const group of groups.values()) group.forEach((l,i)=>{
    l.displayPoint=group.length===1?l.point:[l.point[0]+Math.cos(i*2*Math.PI/group.length)*.00007,l.point[1]+Math.sin(i*2*Math.PI/group.length)*.000055];
  });
  const current=$('rentalType').value;$('rentalType').replaceChildren(new Option('All rental types',''));
  [...new Set(listings.map(l=>l.rental_type).filter(Boolean))].sort().forEach(t=>$('rentalType').add(new Option(t,t)));$('rentalType').value=current;
  $('buildStatus').textContent=`${report.mapped_listings.toLocaleString()} listings · ${currentPermits.length.toLocaleString()} current permit points · ${report.as_of}`;
}
async function getJSON(url) {const response=await fetch(url,{cache:'no-store'});if(!response.ok)throw Error(`${url}: HTTP ${response.status}`);return response.json();}
async function reloadData() {
  [listings,permits,report]=await Promise.all(['listings','permits','build_report'].map(n=>getJSON(`data/${n}.json`)));
  if(report.spatial?.available)spatial=await getJSON('data/spatial.json');
  Reporting.invalidate();
  if(parcelManifest?.available)sourceData('parcels',await getJSON('data/licensed_parcels.geojson'));
  sourceData('boundary',spatial.boundary||collection([]));
  popup?.remove();prepareData();update();Reporting.loadViewport(map);$('refresh').hidden=true;
}
function addSourcesAndLayers() {
  for(const id of ['listings','privacy','permit-points','coverage','addresses','connections','edge-buffer','edge-band','balance','surplus','nearby-parcels'])map.addSource(id,{type:'geojson',data:collection([])});
  map.addSource('boundary',{type:'geojson',data:spatial.boundary||collection([])});
  map.addSource('parcels',{type:'geojson',data:parcelManifest?.available?'data/licensed_parcels.geojson':collection([])});
  map.addLayer({id:'balance-fill',type:'fill',source:'balance',layout:{visibility:'none'},paint:{'fill-color':['interpolate',['linear'],['get','difference'],-20,'#15803d',0,'#f1f5f9',20,'#ef4444',100,'#991b1b'],'fill-opacity':.42}});
  map.addLayer({id:'balance-outline',type:'line',source:'balance',layout:{visibility:'none'},paint:{'line-color':'#475569','line-opacity':.3,'line-width':.5}});
  map.addLayer({id:'surplus-heatmap',type:'heatmap',source:'surplus',layout:{visibility:'none'},paint:{'heatmap-weight':['interpolate',['linear'],['get','difference'],0,0,1,.1,10,.5,50,1],'heatmap-radius':['interpolate',['linear'],['zoom'],9,12,12,35,15,100],'heatmap-opacity':.7,'heatmap-color':['interpolate',['linear'],['heatmap-density'],0,'rgba(255,255,0,0)',.2,'#fde047',.5,'#fb923c',.8,'#ef4444',1,'#991b1b']}});
  map.addLayer({id:'nearby-parcel-fill',type:'fill',source:'nearby-parcels',minzoom:15,paint:{'fill-color':'#94a3b8','fill-opacity':.025}});
  map.addLayer({id:'nearby-parcel-line',type:'line',source:'nearby-parcels',minzoom:15,paint:{'line-color':'#64748b','line-opacity':.65,'line-width':1}});
  map.addLayer({id:'parcel-fill',type:'fill',source:'parcels',paint:{'fill-color':'#22c55e','fill-opacity':.42}});
  map.addLayer({id:'parcel-line',type:'line',source:'parcels',paint:{'line-color':'#15803d','line-width':1.5}});
  map.addLayer({id:'coverage-fill',type:'fill',source:'coverage',paint:{'fill-color':'#4ade80','fill-opacity':.035}});
  map.addLayer({id:'coverage-line',type:'line',source:'coverage',paint:{'line-color':'#15803d','line-opacity':.35,'line-width':1}});
  map.addLayer({id:'privacy-fill',type:'fill',source:'privacy',paint:{'fill-color':'#3b82f6','fill-opacity':.025}});
  map.addLayer({id:'privacy-line',type:'line',source:'privacy',paint:{'line-color':'#2563eb','line-opacity':.23,'line-width':1}});
  map.addLayer({id:'edge-buffer-fill',type:'fill',source:'edge-band',paint:{'fill-color':'#a855f7','fill-opacity':.09}});
  map.addLayer({id:'boundary-halo',type:'line',source:'boundary',paint:{'line-color':'#ffffff','line-width':9,'line-opacity':.95}});
  map.addLayer({id:'boundary-line',type:'line',source:'boundary',paint:{'line-color':'#172b3b','line-width':5}});
  map.addLayer({id:'edge-buffer-line',type:'line',source:'edge-buffer',paint:{'line-color':'#9333ea','line-width':2.5,'line-dasharray':[3,2]}});
  map.addLayer({id:'heatmap',type:'heatmap',source:'listings',layout:{visibility:'none'},paint:{'heatmap-radius':35,'heatmap-opacity':.6}});
  map.addLayer({id:'permit-markers',type:'circle',source:'permit-points',paint:{'circle-radius':4,'circle-color':['get','color'],'circle-stroke-color':'white','circle-stroke-width':1}});
  map.addLayer({id:'connections',type:'line',source:'connections',paint:{'line-color':'#9333ea','line-width':2,'line-dasharray':[2,2]}});
  map.addLayer({id:'listing-markers',type:'circle',source:'listings',paint:{'circle-radius':['interpolate',['linear'],['zoom'],9,3,11,5,13,12,16,20],'circle-color':['get','color'],'circle-stroke-color':['get','stroke'],'circle-stroke-width':2}});
  map.addLayer({id:'listing-labels',type:'symbol',source:'listings',minzoom:12,layout:{'text-field':['get','label'],'text-size':12,'text-line-height':1.05,'text-font':['Noto Sans Regular'],'text-allow-overlap':true,'text-ignore-placement':true},paint:{'text-color':'#172b3b'}});
  map.addLayer({id:'address-labels',type:'symbol',source:'addresses',minzoom:16,layout:{'text-field':['get','address'],'text-size':11,'text-font':['Noto Sans Regular'],'text-offset':[0,2]},paint:{'text-color':'#172b3b','text-halo-color':'white','text-halo-width':2}});
  map.moveLayer('address-labels','listing-markers');
  const warningCanvas=document.createElement('canvas');warningCanvas.width=64;warningCanvas.height=64;
  const ctx=warningCanvas.getContext('2d');ctx.font='48px "Segoe UI Emoji", sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('⚠️',32,32);
  map.addImage('spatial-warning',ctx.getImageData(0,0,64,64),{pixelRatio:2});
  map.addLayer({id:'warning-markers',type:'symbol',source:'listings',filter:['==',['get','warning'],true],layout:{'icon-image':'spatial-warning','icon-size':['interpolate',['linear'],['zoom'],9,.45,13,.7,16,.9],'icon-offset':[30,-30],'icon-allow-overlap':true,'icon-ignore-placement':true}});
  map.on('click','warning-markers',e=>{const l=listings.find(l=>l.listing_id===e.features[0].properties.id);if(l)showListing(l);});
  map.on('click','balance-fill',e=>{
    if(map.queryRenderedFeatures(e.point,{layers:['listing-markers','permit-markers','warning-markers']}).length)return;
    const p=e.features[0].properties;popup?.remove();popup=new maplibregl.Popup({maxWidth:'330px'}).setLngLat(e.lngLat).setHTML(`<h3>Listings − licenses</h3><p>500 × 500 m cell ${esc(p.cell_id)}</p><p><b>${p.listings}</b> listing locations<br><b>${p.permits}</b> current permit records<br><b>${p.difference>0?'+':''}${p.difference}</b> listings minus permits</p><p class="small muted">All records in the selected area, counted once by point location. This is a geographic estimate; Airbnb locations can be displaced. A surplus does not identify which listings lack a permit.</p>`).addTo(map);
  });
  map.on('click','listing-markers',e=>{const l=listings.find(l=>l.listing_id===e.features[0].properties.id);if(l)showListing(l);});
  map.on('click','permit-markers',e=>{if(map.queryRenderedFeatures(e.point,{layers:['listing-markers']}).length)return;const p=permits.find(p=>p.id===e.features[0].properties.id);if(p){popup?.remove();popup=new maplibregl.Popup({maxWidth:'350px'}).setLngLat(p.point).setHTML('<h3>Permit record</h3>'+permitCard(p)).addTo(map);}});
  map.on('click','parcel-fill',e=>{if(map.queryRenderedFeatures(e.point,{layers:['listing-markers','permit-markers','warning-markers']}).length)return;const p=e.features[0].properties;popup?.remove();popup=new maplibregl.Popup().setLngLat(e.lngLat).setHTML(`<h3>${esc(p.address)}</h3><p>Parcel ${esc(p.parcel)}<br>Owner: ${esc(p.owner||'Unavailable')}</p><p>Current permit record on this parcel. Listings or other units on this parcel are not automatically matched.</p>`).addTo(map);});
  map.on('click','nearby-parcel-fill',e=>{if(map.queryRenderedFeatures(e.point,{layers:['listing-markers','permit-markers','warning-markers','parcel-fill']}).length)return;const p=e.features[0].properties;popup?.remove();popup=new maplibregl.Popup({maxWidth:'340px'}).setLngLat(e.lngLat).setHTML(`<h3>${esc(p.address)}</h3><p>Owner: ${esc(p.owner||'Unavailable')}<br>Parcel: ${esc(p.parcel)}</p><p class="small muted">Select an Airbnb listing, then choose Report address or Report listing location to report this parcel as a candidate.</p>`).addTo(map);});
  for(const id of ['listing-markers','permit-markers','parcel-fill']){map.on('mouseenter',id,()=>map.getCanvas().style.cursor='pointer');map.on('mouseleave',id,()=>map.getCanvas().style.cursor='');}
  map.on('moveend',()=>{updateSymbols();updateAddresses();Reporting.loadViewport(map);});
  Reporting.loadViewport(map);
  update();
}
async function scannerStatus() {
  try {const status=await getJSON('data/scanner_status.json');const age=(Date.now()-Date.parse(status.checked_at))/1000;
    $('scanStatus').textContent=age>120?'Scanner heartbeat stale':`Scanner: ${status.state} · ${new Date(status.checked_at).toLocaleTimeString()}`;
  }catch{$('scanStatus').textContent='Static snapshot';}
  try {const latest=await getJSON('data/build_report.json');if(latest.built_at!==report.built_at)$('refresh').hidden=false;}catch{}
}
async function init() {
  try {
    [listings,permits,report]=await Promise.all(['listings','permits','build_report'].map(n=>getJSON(`data/${n}.json`)));
    try{parcelManifest=await getJSON('data/parcels/manifest.json');}catch{parcelManifest={available:false};}
    if(report.spatial?.available)spatial=await getJSON('data/spatial.json');
    if(!spatial.available){for(const id of ['scopeOnly','likely','warningSymbols','difference','surplusHeatmap']){$(id).checked=false;$(id).disabled=true;}}
    prepareData();
    map=new maplibregl.Map({container:'map',center:[-86.7816,36.1627],zoom:11,style:{version:8,glyphs:'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',sources:{osm:{type:'raster',tiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],tileSize:256,attribution:'© OpenStreetMap contributors'}},layers:[{id:'basemap',type:'raster',source:'osm'}]}});
    map.addControl(new maplibregl.NavigationControl(),'top-right');map.addControl(new maplibregl.ScaleControl());
    map.on('load',addSourcesAndLayers);
    for(const el of document.querySelectorAll('#filters input,#filters select'))el.addEventListener(el.type==='search'?'input':'change',()=>{clearTimeout(refreshTimer);refreshTimer=setTimeout(update,el.type==='search'?180:0);});
    $('toggleFilters').onclick=()=>{const collapsed=$('filters').classList.toggle('collapsed');$('toggleFilters').textContent=collapsed?'Show':'Hide';$('toggleFilters').setAttribute('aria-expanded',String(!collapsed));};
    $('clearHost').onclick=()=>{selectedHost='';update();};
    $('resetZoom').onclick=()=>map.flyTo({center:[-86.7816,36.1627],zoom:11});
    $('fitArea').onclick=()=>{if(!spatial.available)return;const b=new maplibregl.LngLatBounds();function visit(v){if(typeof v[0]==='number')b.extend(v);else v.forEach(visit);}spatial.boundary.features.forEach(f=>visit(f.geometry.coordinates));map.fitBounds(b,{padding:window.innerWidth>700?{left:330,right:65,top:40,bottom:45}:40});};
    $('reset').onclick=()=>{for(const e of document.querySelectorAll('#filters input')){if(e.type==='checkbox')e.checked=e.defaultChecked;else e.value=e.defaultValue;}for(const e of document.querySelectorAll('#filters select'))e.selectedIndex=0;selectedHost='';update();};
    $('refresh').onclick=reloadData;
    Reporting.setup();
    scannerStatus();setInterval(scannerStatus,30000);
    // Small public interface for reproducible browser validation.
    window.nashville={get map(){return map;},get listings(){return listings;},get permits(){return permits;},get visible(){return visible;},get selectedListing(){return selectedListing;},get spatial(){return spatial;},get balance(){return balance;},likelyUnlicensed,showListing,markerColor,filterListings,update,ring};
  }catch(error){console.error(error);$('counts').textContent='Map could not load. Serve this folder over HTTP and check the data files.';$('buildStatus').textContent=error.message;}
}
init();
