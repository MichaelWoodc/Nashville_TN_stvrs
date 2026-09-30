'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const collection = features => ({type:'FeatureCollection', features});
const feature = (geometry, properties={}) => ({type:'Feature', geometry, properties});
const icons = {pool:'🩱',hot_tub:'👙',bar:'🍻',pool_table:'🎱',karaoke:'🎤',bachelor_party:'💍🤵🏻',bachelorette_party:'💍💐👰🏻‍♀️'};
const communityStatusNames = {no_license_at_address:'Community submitted: no license at address',license_at_address:'Community submitted: license at address',undetermined:'Undetermined · not matched to address yet'};
const ESTIMATED_STVR_FEE=313;
let listings=[], permits=[], report, visible=[], selectedHost='', selectedHostMetric='', map, popup, emojiMarkers=[], refreshTimer;
const permitGrid = new Map(), addressCache = new Map();
let currentPermits=[], parcelManifest, addressRequest=0;
let spatial={available:false}, balance=[], balanceKey=null;
let selectedListing=null, hoveredPrivacyId=null, selectedPartyCombo='', selectedPartyRequireCapacity=false, pendingHostKey='';
let licensedParcels=null, activeListingPointIndex=null;
let hostSortKey='total',hostSortDirection='desc';
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
function hostKey(l) { return l.host_user_id || String(l.host_profile_url||'').trim().toLowerCase() || `name:${l.host_name || '(unknown)'}`; }
function normalizeParcel(value) { return String(value||'').replace(/[^a-z\d]/gi,'').toUpperCase(); }
function listingPointIndex(items) {
  const bins=new Map();
  for(const item of items)if(item.point){const key=`${Math.floor(item.point[0]*100)}_${Math.floor(item.point[1]*100)}`;if(!bins.has(key))bins.set(key,[]);bins.get(key).push(item.point);}
  return bins;
}
function nearVisibleListing(point,index=activeListingPointIndex) {
  if(!selectedHost||!index)return true;
  const x=Math.floor(point[0]*100),y=Math.floor(point[1]*100);
  for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const listingPoint of index.get(`${x+dx}_${y+dy}`)||[])if(distance(point,listingPoint)<=550)return true;
  return false;
}
function openComplaint(address='', point=null, listingUrl='') {
  const url=new URL('https://docs.google.com/forms/d/e/1FAIpQLSfjyNy_1KBORvjiCx7fhIXTupuaQWXS8VDS0ttXh8Go95eCJg/viewform?usp=pp_url');
  url.searchParams.set('entry.743148639',address||'');url.searchParams.set('entry.1753077861',point?.[1]??'');
  url.searchParams.set('entry.1569813902',point?.[0]??'');url.searchParams.set('entry.1841045190',listingUrl||'');
  window.open(url.toString(),'_blank','noopener,noreferrer');
}
function bindComplaintButton(container,address,point,listingUrl='') {
  container.querySelector('[data-complaint]')?.addEventListener('click',()=>openComplaint(address,point,listingUrl));
}
function amenityCombo(listing) {
  return Object.keys(listing.amenities||{}).filter(key=>icons[key]).sort().join('|');
}
function communityStatus(listing) {
  return communityStatusNames[listing.community_license_status] ? listing.community_license_status : 'undetermined';
}
function overCapacityFlag(listing) {
  return Number(listing?.over_capacity)>0&&(!(Number(listing?.bedrooms)>5)||$('includeLargeOverCapacity').checked);
}
function filterListings() {
  const query=$('search').value.trim().toLowerCase(), selected=[...document.querySelectorAll('.amenity:checked')].map(e=>e.value);
  const communityStatuses=[...document.querySelectorAll('.community-status:checked')].map(e=>e.value);
  const minimum=Number($('over').value), radius=Number($('radius').value);
  return listings.filter(l=>l.point && (!query||l.search.includes(query)) && (!selectedHost||hostKey(l)===selectedHost)
    && (!$('scopeOnly').checked||Spatial.inScope(l,edgeBuffer()))
    && (!$('likely').checked||likelyUnlicensed(l))
    && (!$('nearOnly').checked||(typeof l.nearest_licensed_parcel_m==='number'&&l.nearest_licensed_parcel_m<=9.144))
    && communityStatuses.includes(communityStatus(l))
    && (!minimum||(overCapacityFlag(l)&&l.over_capacity>=minimum))
    && (!$('partyOnly').checked||(l.party_house||overCapacityFlag(l)))
    && (!selectedPartyRequireCapacity||(selectedHost&&['party','combo'].includes(selectedHostMetric)&&overCapacityFlag(l)))
    && (selectedHostMetric!=='combo'||amenityCombo(l)===selectedPartyCombo)
    && (!selected.length||($('allAmenities').checked?selected.every(k=>l.amenities[k]):selected.some(k=>l.amenities[k])))
    && (!$('rentalType').value||l.rental_type===$('rentalType').value)
    && (!$('outside').checked||outsideCoverage(l,radius)));
}
function exploreFiltersActive() {
  const controls=[...document.querySelectorAll('#filters input,#filters select')].filter(control=>!control.disabled);
  return Boolean(selectedHost||selectedPartyCombo||selectedPartyRequireCapacity)||controls.some(control=>{
    if(control.type==='checkbox'||control.type==='radio')return control.checked!==control.defaultChecked;
    if(control.tagName==='SELECT')return control.selectedIndex!==0;
    return control.value!==control.defaultValue;
  });
}
function updateExploreClearButton() {
  const button=$('clearExploreFilters');
  if(!button)return;
  const active=exploreFiltersActive();
  button.hidden=!active;
  button.classList.toggle('filter-attention',active);
  button.setAttribute('aria-pressed',String(active));
}
function resetExploreFilters() {
  for(const control of document.querySelectorAll('#filters input')){
    if(control.type==='checkbox')control.checked=control.defaultChecked;
    else control.value=control.defaultValue;
  }
  for(const control of document.querySelectorAll('#filters select'))control.selectedIndex=0;
  selectedHost='';selectedHostMetric='';selectedPartyCombo='';selectedPartyRequireCapacity=false;
  $('hostSearch').value='';
  update();
}
function markerColor(l) {
  if(l.license_status==='expired') return '#facc15';
  if(l.license_status==='current') return '#22c55e';
  if(overCapacityFlag(l)) return '#fb7185';
  if(l.license_status==='other') return '#c4b5fd';
  return '#e2e8f0';
}
function listingFeature(l) {
  return feature({type:'Point',coordinates:l.displayPoint||l.point},{id:l.listing_id,color:markerColor(l),warning:!!likelyUnlicensed(l),
    stroke:overCapacityFlag(l)?'#dc2626':'#2563eb',
    label:(l.guests===null?'?':String(l.guests))+(overCapacityFlag(l)?'\n+'+l.over_capacity:'')});
}
function sourceData(id,data) { map.getSource(id)?.setData(data); }
function layerVisibility(ids,on) { for(const id of ids) if(map.getLayer(id)) map.setLayoutProperty(id,'visibility',on?'visible':'none'); }
function updatePrivacy() {
  const subjects=selectedListing?[selectedListing]:visible;
  sourceData('privacy',collection($('privacy').checked?subjects.filter(l=>l.privacy_radius_meters>0||l===selectedListing).map(l=>{const radius=l.privacy_radius_meters>0?l.privacy_radius_meters:15;const f=feature(ring(l.point,radius),{id:l.listing_id,selected:l===selectedListing,radius_m:radius,radius_source:l.privacy_radius_meters>0?'airbnb_listing_data':'display_fallback'});f.id=l.listing_id;return f;}):[]));
}

function update() {
  if(!map?.getSource('listings')) return;
  updateExploreClearButton();
  visible=filterListings();
  activeListingPointIndex=selectedHost?listingPointIndex(visible):null;
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
  const nearbyPermits=displayedPermits.filter(p=>p.point&&nearVisibleListing(p.point));
  sourceData('permit-points',collection($('permits').checked?nearbyPermits.map(p=>feature({type:'Point',coordinates:p.point},{id:p.id,color:p.status==='current'?'#15803d':p.status==='expired'?'#eab308':p.status==='revoked'?'#dc2626':'#a78bfa'})):[]));
  if(licensedParcels){const nearbyParcels=new Set(nearbyPermits.filter(p=>p.status==='current').map(p=>normalizeParcel(p.parcel)).filter(Boolean));sourceData('parcels',collection($('parcels').checked?licensedParcels.features.filter(f=>!selectedHost||nearbyParcels.has(normalizeParcel(f.properties.parcel))):[]));}
  const radius=Number($('radius').value);
  $('radiusValue').textContent=`${radius} m`;
  sourceData('coverage',collection($('coverage').checked&&radius>0?currentPermits.filter(p=>nearVisibleListing(p.point)).map(p=>feature(ring(p.point,radius))):[]));
  $('counts').textContent=`${visible.length.toLocaleString()} visible · ${report.mapped_listings.toLocaleString()} mapped · ${(report.listings-report.mapped_listings).toLocaleString()} awaiting location`;
  updateHosts(); updateSearch(); updateSymbols(); updateAddresses();
}
function updateBalance() {
  if(!spatial.available)return;
  const radius=Number($('heatRadius').value),intensity=Number($('heatIntensity').value)/100;
  $('heatRadiusValue').textContent=`${radius} m`;$('heatIntensityValue').textContent=`${Math.round(intensity*100)}%`;
  const key=String(edgeBuffer());
  if(balanceKey!==key) {
    balance=Spatial.balanceCells(listings,permits,spatial.cells,edgeBuffer(),0);balanceKey=key;
    sourceData('balance',collection(balance));
  }
  const toHeatPoints=(features,sign)=>features.filter(f=>sign*f.properties.difference>0&&nearVisibleListing(f.properties.center)).map(f=>feature({type:'Point',coordinates:f.properties.center},{weight:Math.min(1,Math.abs(f.properties.difference)/8),radius_scale:Math.max(.01,radius/550)}));
  sourceData('surplus',collection(toHeatPoints(balance,1)));
  sourceData('deficit',collection(toHeatPoints(balance,-1)));
  for(const id of ['surplus-heatmap','deficit-heatmap'])if(map.getLayer(id))map.setPaintProperty(id,'heatmap-opacity',intensity/2);
  layerVisibility(['balance-fill','balance-outline'],$ ('difference').checked);
  layerVisibility(['surplus-heatmap','deficit-heatmap'],$ ('surplusHeatmap').checked);
  const listingCount=new Set(listings.filter(l=>l.point&&l.cell_id&&Spatial.inScope(l,edgeBuffer())).map(l=>l.listing_id)).size;
  const propertyCount=new Set(permits.filter(p=>p.status==='current'&&p.point&&p.cell_id&&Spatial.inScope(p,edgeBuffer())).map(p=>normalizeParcel(p.parcel)||`record:${p.id}`)).size;
  $('balanceSummary').textContent=`${listingCount.toLocaleString()} listing locations · ${propertyCount.toLocaleString()} distinct current-permit properties. Counts are counted once here; heat cells show local radius-smoothed differences.`;
}
function updateHosts() {
  $('clearHost').classList.toggle('filter-attention',Boolean(selectedHost));
  $('clearHost').setAttribute('aria-pressed',String(Boolean(selectedHost)));
  const groups=new Map();
  for(const l of visible) {const key=hostKey(l);if(!groups.has(key))groups.set(key,{name:l.host_name||'Unknown host',items:[]});groups.get(key).items.push(l);}
  const hostQuery=$('hostSearch').value.trim().toLowerCase();
  const metric=group=>hostSortKey==='likely'?group.items.filter(likelyUnlicensed).length:hostSortKey==='party'?group.items.filter(l=>l.party_house||overCapacityFlag(l)).length:group.items.length;
  const filteredGroups=[...groups].filter(([,group])=>group.name.toLowerCase().includes(hostQuery)).sort((a,b)=>{
    const comparison=hostSortKey==='host'?a[1].name.localeCompare(b[1].name):metric(a[1])-metric(b[1])||a[1].name.localeCompare(b[1].name);
    return comparison*(hostSortDirection==='asc'?1:-1);
  });
  $('hostCount').textContent=`(${filteredGroups.length})`;
  $('hosts').replaceChildren();
  const heading=document.createElement('div');heading.className='host-grid host-column-labels';
  for(const [key,label] of [['host','Host'],['total','Total'],['likely','Possibly unlicensed'],['party','Party* / over cap']]){
    const button=document.createElement('button');button.type='button';button.dataset.sortKey=key;button.className='host-sort'+(hostSortKey===key?' active':'');button.setAttribute('aria-sort',hostSortKey===key?(hostSortDirection==='asc'?'ascending':'descending'):'none');
    button.textContent=`${label}${hostSortKey===key?(hostSortDirection==='asc'?' ▲':' ▼'):''}`;
    button.onclick=()=>{if(hostSortKey===key)hostSortDirection=hostSortDirection==='asc'?'desc':'asc';else{hostSortKey=key;hostSortDirection=key==='host'?'asc':'desc';}updateHosts();};heading.append(button);
  }
  $('hosts').append(heading);
  for(const [key,g] of filteredGroups) {
    const row=document.createElement('div');row.className='host-row host-grid';
    const name=document.createElement('button');name.className='host-name'+(key===selectedHost?' selected':'');name.textContent=g.name;const identity=g.items[0];name.title=identity.host_user_id?`Host ID ${identity.host_user_id}`:identity.host_profile_url||g.name;name.onclick=()=>{selectedHost=key;selectedHostMetric='total';selectedPartyRequireCapacity=false;$('partyOnly').checked=false;update();fitVisible();};
    const total=document.createElement('button');total.className='host-count'+(selectedHost===key&&selectedHostMetric==='total'?' filter-active':'');total.textContent=g.items.length;total.title='Filter map to this host';total.onclick=()=>{selectedHost=key;selectedHostMetric='total';selectedPartyRequireCapacity=false;$('partyOnly').checked=false;update();fitVisible();};
    const unlicensed=document.createElement('button');unlicensed.className='host-metric'+(selectedHost===key&&selectedHostMetric==='likely'?' filter-active':'');unlicensed.textContent=g.items.filter(likelyUnlicensed).length;unlicensed.title='Filter this host to possibly unlicensed locations';
    unlicensed.onclick=()=>{selectedHost=key;selectedHostMetric='likely';selectedPartyRequireCapacity=false;$('partyOnly').checked=false;$('likely').checked=true;update();fitVisible();};
    const party=document.createElement('button');party.className='host-metric'+(selectedHost===key&&selectedHostMetric==='party'?' filter-active':'');party.textContent=g.items.filter(l=>l.party_house||overCapacityFlag(l)).length;party.title='Party keyword matches or over-capacity listings; screening signals only';
    party.onclick=()=>{selectedHost=key;selectedHostMetric='party';selectedPartyCombo='';selectedPartyRequireCapacity=false;$('partyOnly').checked=true;update();fitVisible();$('partyDisclaimer').showModal();};
    row.append(name,total,unlicensed,party);$('hosts').append(row);
    if(key===selectedHost&&['party','combo'].includes(selectedHostMetric)) {
      const combinations=new Map();
      for(const listing of listings.filter(item=>hostKey(item)===key&&(item.party_house||overCapacityFlag(item)))) {
        const combo=amenityCombo(listing);if(combo)combinations.set(combo,(combinations.get(combo)||0)+1);
      }
      const comboRow=document.createElement('div');comboRow.className='host-combos';
      const capacityLabel=document.createElement('label');capacityLabel.className='host-capacity-filter';const capacityToggle=document.createElement('input');capacityToggle.type='checkbox';capacityToggle.checked=selectedPartyRequireCapacity;capacityToggle.onchange=()=>{selectedPartyRequireCapacity=capacityToggle.checked;update();};capacityLabel.append(capacityToggle,document.createTextNode('Require over capacity'));comboRow.append(capacityLabel);
      const largeCapacityLabel=document.createElement('label');largeCapacityLabel.className='host-capacity-filter';const largeCapacityToggle=document.createElement('input');largeCapacityToggle.type='checkbox';largeCapacityToggle.checked=$('includeLargeOverCapacity').checked;largeCapacityToggle.onchange=()=>{$('includeLargeOverCapacity').checked=largeCapacityToggle.checked;update();};largeCapacityLabel.append(largeCapacityToggle,document.createTextNode('Include >5-bedroom over-capacity listings'));comboRow.append(largeCapacityLabel);
      for(const [combo,count] of [...combinations].sort((a,b)=>a[0].localeCompare(b[0]))) {
        const button=document.createElement('button');button.type='button';button.className='host-combo'+(selectedHostMetric==='combo'&&selectedPartyCombo===combo?' selected':'');
        button.textContent=`${combo.split('|').map(key=>icons[key]).join(' ')} ${count}`;
        button.title=`Show ${count} listing${count===1?'':'s'} with this exact amenity combination`;
        button.setAttribute('aria-pressed',String(selectedHostMetric==='combo'&&selectedPartyCombo===combo));
        button.onclick=()=>{selectedHost=key;selectedHostMetric='combo';selectedPartyCombo=combo;$('partyOnly').checked=true;update();fitVisible();};
        comboRow.append(button);
      }
      if(combinations.size||selectedHostMetric==='party')$('hosts').append(comboRow);
    }
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
  const candidates=visible.filter(l=>(l.party_house||overCapacityFlag(l))&&bounds.contains(l.displayPoint||l.point));
  const show=candidates.slice(0,600);
  if(candidates.length>600) $('symbolNote').textContent='Showing symbols for 600 on-screen listings. Zoom in or filter to see the others.';
  for(const l of show) {
    const values=[...new Set(['🥳',...Object.keys(l.amenities).filter(k=>!selected.length||selected.includes(k)).map(k=>icons[k]).filter(Boolean)])];
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
function detectedPermitList(listing) {
  return Array.isArray(listing?.permit_numbers) ? listing.permit_numbers.filter(Boolean) : [];
}
function actualPermitList(listing) {
  return Array.isArray(listing?.matched_permits) ? listing.matched_permits.map(p => String(p?.permit_number ?? p?.permit ?? p?.id ?? p?.number ?? '').trim()).filter(Boolean) : [];
}
function setupAppearanceAndDisclaimer() {
  let theme='light',dismissed=false;
  try {theme=localStorage.getItem('stvr-doorman-theme')||'light';dismissed=localStorage.getItem('stvr-doorman-disclaimer-dismissed')==='yes';} catch {}
  const applyTheme=value=>{document.body.classList.toggle('dark-mode',value==='dark');$('themeToggle').checked=value==='dark';$('themeToggle').setAttribute('aria-pressed',String(value==='dark'));};
  applyTheme(theme);
  $('themeToggle').addEventListener('change',()=>{const value=$('themeToggle').checked?'dark':'light';applyTheme(value);try{localStorage.setItem('stvr-doorman-theme',value);}catch{}});
  const disclaimer=$('firstVisitDisclaimer');
  disclaimer.addEventListener('cancel',event=>event.preventDefault());
  $('dismissFirstVisit').onclick=()=>{try{localStorage.setItem('stvr-doorman-disclaimer-dismissed','yes');}catch{}disclaimer.close();};
  if(!dismissed)disclaimer.showModal();
}
function setupResponsivePanels() {
  const wrapper=$('mobilePanels'),filters=$('filters'),hosts=document.querySelector('.hosts'),details=hosts.querySelector('details'),toggle=$('toggleFilters');
  let wasMobile=null;
  const sync=()=>{
    const mobile=matchMedia('(max-width: 700px)').matches;
    if(mobile!==wasMobile){
      if(mobile){filters.classList.add('collapsed');details.open=false;}
      else filters.classList.remove('collapsed');
      wasMobile=mobile;
    }
    wrapper.classList.toggle('panel-expanded',mobile&&(!filters.classList.contains('collapsed')||details.open));
    toggle.textContent=filters.classList.contains('collapsed')?'Show':'Hide';
    toggle.setAttribute('aria-expanded',String(!filters.classList.contains('collapsed')));
  };
  toggle.onclick=()=>{
    if(filters.classList.contains('collapsed')){details.open=false;filters.classList.remove('collapsed');}
    else filters.classList.add('collapsed');
    sync();
  };
  details.addEventListener('toggle',()=>{if(matchMedia('(max-width: 700px)').matches&&details.open)filters.classList.add('collapsed');sync();});
  window.addEventListener('resize',sync);sync();
}
function showNearbyPermitListings(permit, container) {
  const candidates=listings.filter(listing=>listing.point).map(listing=>({listing,distance_m:distance(permit.point,listing.point)})).filter(item=>item.distance_m<=550).sort((a,b)=>a.distance_m-b.distance_m||String(a.listing.host_name).localeCompare(String(b.listing.host_name)));
  const section=document.createElement('section');section.className='license-match-candidates';
  const heading=document.createElement('h4');heading.textContent=`Nearby Airbnb listings (${candidates.length})`;section.append(heading);
  const note=document.createElement('p');note.className='small muted';note.textContent='Within 550 m of this permit location. Proximity is a candidate for review, not confirmation of a license match.';section.append(note);
  if(!candidates.length){const empty=document.createElement('p');empty.className='small muted';empty.textContent='No mapped listings are within 550 m.';section.append(empty);}
  for(const {listing,distance_m} of candidates){
    const button=document.createElement('button');button.type='button';button.className='license-listing-candidate';
    const title=document.createElement('strong');title.textContent=listing.title||`Listing ${listing.listing_id}`;
    const details=document.createElement('span');details.textContent=`Host: ${listing.host_name||'Unknown'} · ${distance_m.toFixed(1)} m${listing.host_user_id?` · Host ID ${listing.host_user_id}`:''}`;
    button.append(title,details);button.onclick=()=>{popup?.remove();popup=null;showListing(listing,permit);};section.append(button);
  }
  container.replaceChildren(section);
}
function showListing(l, nearbyPermit=null) {
  popup?.remove();
  selectedListing=l;updatePrivacy();
  const privacy=l.privacy_radius_meters===null?'Unknown':`${l.privacy_radius_meters} m`;
  const listingSource=`<a href="${esc(l.url)}" target="_blank" rel="noopener">Airbnb.com listing</a>`;
  let html=`<h3>${esc(l.title||'Airbnb listing')}</h3><span class="badge ${esc(communityStatus(l))}">${esc(communityStatusNames[communityStatus(l)])}</span><p><a href="${esc(l.url)}" target="_blank" rel="noopener">Open Airbnb listing ↗</a></p><p><b>Host:</b> <button type="button" class="popup-host-select" data-select-host>${esc(l.host_name||'Unknown')}</button><br><b>Guests:</b> ${esc(l.guests??'Unknown')} · <b>Bedrooms:</b> ${esc(l.bedrooms??'Unknown')}<br><b>Capacity:</b> ${esc(l.allowed_guests??"Unknown (bedrooms missing)")} guests${overCapacityFlag(l)?`<br><b>Over capacity:</b> <a href="https://www.nashville.gov/departments/codes/short-term-rentals/operation-rules-and-requirements" target="_blank" rel="noopener">${esc(l.over_capacity)} guests · Nashville rules ↗</a>`:''}<br><b>Airbnb privacy radius:</b> ${esc(privacy)}<br><b>Approximate location:</b> ${esc(l.approximate_address||l.location_name||'Unknown')}</p>`;
  const detectedCount=Number(l.detected_permit_count??detectedPermitList(l).length);
  const dualCapacity=Boolean(l.dual_license_capacity)||detectedCount===2;
  const titleMentionsTwo=/\btwo\b/i.test(l.title||'');
  if(dualCapacity||titleMentionsTwo)html+=`<p class="small spatial-warning"><b>Capacity estimate caveat:</b> ${dualCapacity?'Two permit numbers were detected in listing text; the estimate treats them as two units, splits bedrooms between units, and allows up to 12 guests per unit.':'The title mentions “two”, which may refer to multiple units.'} This is an unverified screening assumption, not confirmation of separate licensed units. Please verify the actual unit and bedroom configuration.</p>`;
  if(Number(l.bedrooms)>5&&(Number(l.over_capacity)||0)>0)html+=`<p class="small muted">This listing has more than 5 bedrooms. Its over-capacity flag is excluded from filters by default; enable “Include listings with over 5 bedrooms in over-capacity results” to include it.</p>`;
  if(detectedPermitList(l).length) html+=`<p><b>Detected listing permit numbers:</b> ${detectedPermitList(l).map(esc).join(', ')}<br><span class="small muted">These are text matches from the listing and are not the canonical license list.</span></p>`;
  if(actualPermitList(l).length) html+=`<p><b>Actual matched permit records:</b> ${actualPermitList(l).map(esc).join(', ')}</p>`;
  if(nearbyPermit)html+=`<h4>Nearby permit for review</h4><p class="small muted">Selected from permit locations within 550 m. This is not a confirmed match.</p>${permitCard(nearbyPermit)}`;
  const overlap=Spatial.overlap(l,leeway(),parcelTolerance()), effective=Spatial.effectiveRadius(l,leeway());
  const spatialText=!spatial.available?'Spatial data unavailable':!Spatial.inScope(l,edgeBuffer())?'Outside the selected analysis area':overlap===null?'Unknown: privacy radius or parcel geometry missing':overlap?'Privacy circle reaches a green permitted parcel':'⚠️ Likely unlicensed location: privacy circle does not reach any current-permit parcel';
  html+=`<p class="${likelyUnlicensed(l)?'spatial-warning':'small'}"><b>Parcel-overlap screening:</b> ${esc(spatialText)}<br>Screening radius with +${leeway()}% leeway: ${effective===null?'Unknown':effective.toFixed(1)+' m'}<br>Extra parcel tolerance: ${parcelTolerance().toFixed(2)} m${parcelTolerance()?' (10 yards)':''}<br>Nearest permitted parcel: ${typeof l.nearest_licensed_parcel_m==='number'?l.nearest_licensed_parcel_m.toFixed(1)+' m':'Unknown'}<br><span class="small muted">${l.privacy_radius_meters>0?'The map circle uses the radius provided with this Airbnb listing.':'The selected map circle is a 15 m display fallback; it is not an Airbnb-provided radius and does not change screening.'} This geographic screen does not verify license status.</span></p>`;
  if(l.matched_permits.length) html+='<h4>Direct permit-number matches</h4>'+l.matched_permits.map(permitCard).join('');
  else html+='<p class="small muted">No direct permit-number match. This does not establish whether a license exists at this address.</p>';
  if(l.party_house) html+=`<p><b>🎉 Party/event keyword matches:</b> ${Object.keys(l.amenities).map(k=>icons[k]).join(' ')}</p><details><summary>Keyword evidence</summary>${Object.entries(l.amenities).map(([k,v])=>`<p>${icons[k]} ${esc(k.replaceAll('_',' '))}<br><span class="evidence">${esc(v.evidence)}<br>Source: ${listingSource}</span></p>`).join('')}</details>`;
  if(l.permit_evidence.length) html+=`<details><summary>Permit-number evidence</summary>${l.permit_evidence.map(e=>`<p><b>${esc(e.number)}</b> (${esc(e.method)})<br><span class="evidence">${esc(e.evidence)}<br>Source: ${listingSource}</span></p>`).join('')}</details>`;
  html+=dualCapacity?'<p class="small muted">Two-unit screening estimate: min(2 × total bedrooms + 8, 24), assuming bedrooms split evenly and each unit gets +4 guests. The detected numbers may be inaccurate and do not confirm separate licensed units. Saved listing data; approximate Airbnb location. <a href="about_data.html">Data and Nashville rules</a></p>':'<p class="small muted">Capacity = min(2 × bedrooms + 4, 12), using advertised bedrooms. Missing bedrooms: only excess above 12 can be flagged. Saved listing data; approximate Airbnb location. <a href="about_data.html">Data and Nashville rules</a></p>';
  html+='<div class="report-actions"><button type="button" data-complaint>Complaint form (with evidence)</button><button type="button" data-report="location">Suggest location correction</button><button type="button" data-report="license">Suggest license correction</button><button type="button" data-report="address">Suggest address correction</button></div>';
  popup=new maplibregl.Popup({maxWidth:'380px',className:'listing-popup-centered'}).setLngLat(l.displayPoint||l.point).setHTML(html).addTo(map);
  popup.getElement().querySelector('[data-select-host]').onclick=()=>{pendingHostKey=hostKey(l);$('hostPromptName').textContent=l.host_name||'Unknown host';$('hostConfirmDialog').showModal();};
  bindComplaintButton(popup.getElement(),l.approximate_address||l.location_name,l.point,l.url);
  popup.getElement().querySelectorAll('[data-report]').forEach(button=>button.onclick=()=>Reporting.open(l,button.dataset.report));
  const linkedPermits=[...l.matched_permits,...(nearbyPermit?[nearbyPermit]:[])];
  const links=[...new Map(linkedPermits.filter(p=>p.point).map(p=>[p.id,feature({type:'LineString',coordinates:[l.point,p.point]})])).values()];
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
  const permitStatusCounts=new Map();
  for(const permit of permits){const status=String(permit.status||'unknown').toLowerCase();permitStatusCounts.set(status,(permitStatusCounts.get(status)||0)+1);}
  const permitStatusLabel=status=>status.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());
  $('buildStatus').textContent=`${report.mapped_listings.toLocaleString()} listings`;
  const currentPermitCount=permitStatusCounts.get('current')||0;
  $('currentPermitCount').textContent=`Current permits ${currentPermitCount.toLocaleString()}`;
  const listingPermitDifference=report.mapped_listings-currentPermitCount;
  const estimatedShortfall=Math.max(0,listingPermitDifference)*ESTIMATED_STVR_FEE;
  $('potentialRevenueButton').textContent=`Potential revenue shortfall ${estimatedShortfall.toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0})}`;
  $('revenueEquation').textContent=`${report.mapped_listings.toLocaleString()} mapped listings − ${currentPermitCount.toLocaleString()} current permit records = ${listingPermitDifference.toLocaleString()} potential unaccounted listings. ${Math.max(0,listingPermitDifference).toLocaleString()} × $${ESTIMATED_STVR_FEE} = ${estimatedShortfall.toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0})} illustrative potential shortfall.`;
  $('revenueSnapshotNote').textContent=`Snapshot date: ${report.as_of}. This arithmetic assumes one permit per mapped listing and a $${ESTIMATED_STVR_FEE} fee per permit.`;
  $('permitInfoDate').textContent=`Permit snapshot as of ${report.as_of}.`;
  const otherStatuses=[...permitStatusCounts].filter(([status])=>status!=='current').sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
  $('otherPermitStatuses').replaceChildren(...otherStatuses.map(([status,count])=>{const row=document.createElement('p');row.className='permit-status-row';const label=document.createElement('span');label.textContent=permitStatusLabel(status);const value=document.createElement('strong');value.textContent=count.toLocaleString();row.append(label,value);return row;}));
}
async function getJSON(url) {const response=await fetch(url,{cache:'no-store'});if(!response.ok)throw Error(`${url}: HTTP ${response.status}`);return response.json();}
async function reloadData() {
  [listings,permits,report]=await Promise.all(['listings','permits','build_report'].map(n=>getJSON(`data/${n}.json`)));
  if(report.spatial?.available)spatial=await getJSON('data/spatial.json');
  Reporting.invalidate();
  if(parcelManifest?.available){licensedParcels=await getJSON('data/licensed_parcels.geojson');sourceData('parcels',licensedParcels);}
  sourceData('boundary',spatial.boundary||collection([]));
  popup?.remove();prepareData();update();Reporting.loadViewport(map);$('refresh').hidden=true;
}
function addSourcesAndLayers() {
  for(const id of ['listings','privacy','permit-points','coverage','addresses','connections','edge-buffer','edge-band','balance','surplus','deficit','nearby-parcels'])map.addSource(id,{type:'geojson',data:collection([])});
  map.addSource('boundary',{type:'geojson',data:spatial.boundary||collection([])});
  map.addSource('parcels',{type:'geojson',data:licensedParcels||collection([])});
  map.addLayer({id:'balance-fill',type:'fill',source:'balance',layout:{visibility:'none'},paint:{'fill-color':['interpolate',['linear'],['get','difference'],-20,'#15803d',0,'#f1f5f9',20,'#ef4444',100,'#991b1b'],'fill-opacity':.42}});
  map.addLayer({id:'balance-outline',type:'line',source:'balance',layout:{visibility:'none'},paint:{'line-color':'#475569','line-opacity':.3,'line-width':.5}});
  map.addLayer({id:'surplus-heatmap',type:'heatmap',source:'surplus',layout:{visibility:'none'},paint:{'heatmap-weight':['get','weight'],'heatmap-radius':['interpolate',['linear'],['zoom'],9,['*',['get','radius_scale'],2],11,['*',['get','radius_scale'],8],13,['*',['get','radius_scale'],32],15,['*',['get','radius_scale'],128]],'heatmap-intensity':1,'heatmap-opacity':.15,'heatmap-color':['interpolate',['linear'],['heatmap-density'],0,'rgba(255,255,255,0)',.02,'rgba(254,202,202,.7)',.08,'rgba(239,68,68,.85)',.22,'rgba(185,28,28,.92)',1,'rgba(127,29,29,.96)']}});
  map.addLayer({id:'deficit-heatmap',type:'heatmap',source:'deficit',layout:{visibility:'none'},paint:{'heatmap-weight':['get','weight'],'heatmap-radius':['interpolate',['linear'],['zoom'],9,['*',['get','radius_scale'],2],11,['*',['get','radius_scale'],8],13,['*',['get','radius_scale'],32],15,['*',['get','radius_scale'],128]],'heatmap-intensity':1,'heatmap-opacity':.15,'heatmap-color':['interpolate',['linear'],['heatmap-density'],0,'rgba(255,255,255,0)',.02,'rgba(237,247,237,.65)',.08,'rgba(205,232,205,.75)',.22,'rgba(151,201,151,.85)',1,'rgba(112,168,112,.9)']}});
  map.addLayer({id:'nearby-parcel-fill',type:'fill',source:'nearby-parcels',minzoom:15,paint:{'fill-color':'#94a3b8','fill-opacity':.025}});
  map.addLayer({id:'nearby-parcel-line',type:'line',source:'nearby-parcels',minzoom:15,paint:{'line-color':'#64748b','line-opacity':.65,'line-width':1}});
  map.addLayer({id:'parcel-fill',type:'fill',source:'parcels',paint:{'fill-color':'#22c55e','fill-opacity':.42}});
  map.addLayer({id:'parcel-line',type:'line',source:'parcels',paint:{'line-color':'#15803d','line-width':1.5}});
  map.addLayer({id:'coverage-fill',type:'fill',source:'coverage',paint:{'fill-color':'#4ade80','fill-opacity':.035}});
  map.addLayer({id:'coverage-line',type:'line',source:'coverage',paint:{'line-color':'#15803d','line-opacity':.35,'line-width':1}});
  map.addLayer({id:'privacy-fill',type:'fill',source:'privacy',paint:{'fill-color':'#3b82f6','fill-opacity':['case',['boolean',['get','selected'],false],.12,0]}});
  map.addLayer({id:'privacy-line',type:'line',source:'privacy',paint:{'line-color':'#2563eb','line-opacity':.32,'line-width':['case',['boolean',['feature-state','hover'],false],4.5,['boolean',['get','selected'],false],3,1.5]}});
  map.moveLayer('privacy-fill','parcel-fill');
  map.moveLayer('privacy-line','parcel-fill');
  map.moveLayer('surplus-heatmap','parcel-fill');
  map.moveLayer('deficit-heatmap','parcel-fill');
  function setPrivacyHover(id) {
    if(hoveredPrivacyId!==null)map.setFeatureState({source:'privacy',id:hoveredPrivacyId},{hover:false});
    hoveredPrivacyId=id===null?null:String(id);
    if(hoveredPrivacyId!==null)map.setFeatureState({source:'privacy',id:hoveredPrivacyId},{hover:true});
  }
  map.on('mouseenter','privacy-line',e=>{const id=e.features?.[0]?.id;if(id===undefined)return;setPrivacyHover(id);map.getCanvas().style.cursor='pointer';});
  map.on('mouseleave','privacy-line',()=>{setPrivacyHover(null);map.getCanvas().style.cursor='';});
  map.on('mouseenter','listing-markers',e=>{const id=e.features?.[0]?.properties?.id;if(id!==undefined)setPrivacyHover(id);});
  map.on('mouseleave','listing-markers',()=>setPrivacyHover(null));
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
  map.on('click','permit-markers',e=>{if(map.queryRenderedFeatures(e.point,{layers:['listing-markers']}).length)return;const p=permits.find(p=>p.id===e.features[0].properties.id);if(p){popup?.remove();popup=new maplibregl.Popup({maxWidth:'360px'}).setLngLat(p.point).setHTML('<h3>Permit record</h3>'+permitCard(p)+'<button type="button" data-match-license>Match license to listing</button><div data-license-candidates></div>').addTo(map);popup.getElement().querySelector('[data-match-license]').onclick=()=>showNearbyPermitListings(p,popup.getElement().querySelector('[data-license-candidates]'));}});
  map.on('click','parcel-fill',e=>{if(map.queryRenderedFeatures(e.point,{layers:['listing-markers','permit-markers','warning-markers']}).length)return;const p=e.features[0].properties;const matches=permits.filter(permit=>permit.status==='current'&&normalizeParcel(permit.parcel)===normalizeParcel(p.parcel));popup?.remove();popup=new maplibregl.Popup({maxWidth:'380px'}).setLngLat(e.lngLat).setHTML(`<h3>Licensed property</h3><p>${esc(p.address)}<br>Parcel ${esc(p.parcel)}<br>Owner: ${esc(p.owner||'Unavailable')}</p>${matches.length?'<h4>Current permit record'+(matches.length>1?'s':'')+'</h4>'+matches.map(permitCard).join(''):'<p class="small muted">This parcel is in the current-permit parcel layer, but no permit row with a matching parcel ID was found in the loaded records.</p>'}`).addTo(map);});
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
  setupAppearanceAndDisclaimer();
  try {
    [listings,permits,report]=await Promise.all(['listings','permits','build_report'].map(n=>getJSON(`data/${n}.json`)));
    try{parcelManifest=await getJSON('data/parcels/manifest.json');}catch{parcelManifest={available:false};}
    if(parcelManifest?.available)licensedParcels=await getJSON('data/licensed_parcels.geojson');
    if(report.spatial?.available)spatial=await getJSON('data/spatial.json');
    if(!spatial.available){for(const id of ['scopeOnly','likely','warningSymbols','difference','surplusHeatmap','heatRadius','heatIntensity']){$(id).checked=false;$(id).disabled=true;}}
    prepareData();
    map=new maplibregl.Map({container:'map',center:[-86.7816,36.1627],zoom:11,style:{version:8,glyphs:'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',sources:{osm:{type:'raster',tiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],tileSize:256,attribution:'© OpenStreetMap contributors'}},layers:[{id:'basemap',type:'raster',source:'osm'}]}});
    map.addControl(new maplibregl.NavigationControl(),'top-right');map.addControl(new maplibregl.ScaleControl());
    map.on('load',addSourcesAndLayers);
    for(const el of document.querySelectorAll('#filters input,#filters select'))el.addEventListener(el.type==='search'?'input':'change',()=>{updateExploreClearButton();clearTimeout(refreshTimer);refreshTimer=setTimeout(update,el.type==='search'?180:0);});
    setupResponsivePanels();
    $('clearExploreFilters').onclick=resetExploreFilters;
    $('hostSearch').addEventListener('input',updateHosts);
    $('clearHost').onclick=()=>{selectedHost='';selectedHostMetric='';selectedPartyCombo='';selectedPartyRequireCapacity=false;$('likely').checked=false;$('partyOnly').checked=false;update();};
    $('currentPermitCount').onclick=()=>$('otherPermitDialog').showModal();$('closeOtherPermits').onclick=()=>$('otherPermitDialog').close();
    $('potentialRevenueButton').onclick=()=>$('revenueDialog').showModal();$('closeRevenueDialog').onclick=()=>$('revenueDialog').close();
    $('sourcesButton').onclick=()=>$('sourcesDialog').showModal();$('closeSourcesDialog').onclick=()=>$('sourcesDialog').close();
    $('aboutButton').onclick=()=>$('aboutDialog').showModal();$('closeAboutDialog').onclick=()=>$('aboutDialog').close();
    $('hostPromptClose').onclick=$('hostPromptNo').onclick=()=>$('hostConfirmDialog').close();
    $('hostPromptYes').onclick=()=>{if(!pendingHostKey)return;selectedHost=pendingHostKey;selectedHostMetric='total';selectedPartyCombo='';selectedPartyRequireCapacity=false;$('partyOnly').checked=false;$('hostSearch').value='';$('hostConfirmDialog').close();popup?.remove();popup=null;update();fitVisible();};
    $('closePartyDisclaimer').onclick=()=>$('partyDisclaimer').close();
    $('resetZoom').onclick=()=>map.flyTo({center:[-86.7816,36.1627],zoom:11});
    $('fitArea').onclick=()=>{if(!spatial.available)return;const b=new maplibregl.LngLatBounds();function visit(v){if(typeof v[0]==='number')b.extend(v);else v.forEach(visit);}spatial.boundary.features.forEach(f=>visit(f.geometry.coordinates));map.fitBounds(b,{padding:window.innerWidth>700?{left:330,right:65,top:40,bottom:45}:40});};
    $('reset').onclick=resetExploreFilters;
    $('refresh').onclick=reloadData;
    Reporting.setup();
    scannerStatus();setInterval(scannerStatus,30000);
    // Small public interface for reproducible browser validation.
    window.nashville={get map(){return map;},get listings(){return listings;},get permits(){return permits;},get visible(){return visible;},get selectedListing(){return selectedListing;},get spatial(){return spatial;},get balance(){return balance;},likelyUnlicensed,showListing,markerColor,filterListings,update,ring};
  }catch(error){console.error(error);$('counts').textContent='Map could not load. Serve this folder over HTTP and check the data files.';$('buildStatus').textContent=error.message;}
}
init();
