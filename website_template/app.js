'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const collection = features => ({type:'FeatureCollection', features});
const feature = (geometry, properties={}) => ({type:'Feature', geometry, properties});
const icons = {pool:'🩱',hot_tub:'👙',bar:'🍻',pool_table:'🎱',karaoke:'🎤',bachelor_party:'💍🤵🏻',bachelorette_party:'💍💐👰🏻‍♀️'};
const customAmenityIcons = {dance_pole:'stripper.png'};
const amenityIconHtml = key => customAmenityIcons[key]
  ? `<img class="amenity-custom-icon" src="${customAmenityIcons[key]}" alt="">`
  : esc(icons[key]||'');
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
  return Object.keys(listing.amenities||{}).filter(key=>icons[key]||customAmenityIcons[key]).sort().join('|');
}
function communityStatus(listing) {
  return communityStatusNames[listing.community_license_status] ? listing.community_license_status : 'undetermined';
}
function overCapacityFlag(listing) {
  return ViolationStats.overOccupancy(listing,!$('includeLargeOverCapacity').checked,$('excludeMultipleOverCapacity').checked);
}
function updateViolationStats() {
  const excludeLarge=!$('includeLargeOverCapacity').checked,excludeMultiple=$('excludeMultipleOverCapacity').checked;
  $('statsExcludeLarge').checked=excludeLarge;$('statsExcludeMultiple').checked=excludeMultiple;
  const scoped=listings.filter(l=>l.point&&Spatial.inScope(l,edgeBuffer()));
  const stats=ViolationStats.summarize(scoped,excludeLarge,excludeMultiple);
  const fmt=n=>n.toLocaleString();
  const percent=stats.percent===null?'N/A':stats.percent.toFixed(1)+'%';
  $('violationStatsButton').textContent=spatial.available?`${percent} potential violations`:'Potential violations N/A';
  $('violationStatsButton').title='Over-occupancy percentage · click for counts, exclusions and map filters';
  $('occupancyEquation').textContent=spatial.available
    ?`${fmt(stats.over)} over-occupancy listings ÷ ${fmt(stats.eligible)} eligible listings with known occupancy × 100 = ${percent}.`
    :'Analysis-area data unavailable; no occupancy percentage calculated.';
  const rows=[['Mapped listings in analysis area',stats.total],['Likely hotels excluded',stats.hotels],['More than 5 bedrooms excluded',stats.large],['Multiple license numbers excluded (after bedroom exclusion)',stats.multiple],['Unknown occupancy excluded',stats.unknown],['Eligible denominator',stats.eligible]];
  $('occupancyBreakdown').replaceChildren(...rows.map(([label,count])=>{const row=document.createElement('p');row.className='permit-status-row';const name=document.createElement('span');name.textContent=label;const value=document.createElement('strong');value.textContent=fmt(count);row.append(name,value);return row;}));
  $('showOverOccupancy').textContent=`Over occupancy: ${fmt(stats.over)} · Show on map (+1)`;
  $('showOverOccupancy').disabled=!spatial.available||!stats.over;
  const nonHotels=scoped.filter(l=>!l.likely_hotel),known=nonHotels.filter(l=>Spatial.overlap(l,leeway(),parcelTolerance())!==null);
  const likely=known.filter(likelyUnlicensed).length;
  $('likelyStatsEquation').textContent=spatial.available
    ?`${fmt(likely)} likely-unlicensed listings ÷ ${fmt(known.length)} spatially assessable non-hotel listings = ${known.length?(100*likely/known.length).toFixed(1)+'%':'N/A'}. ${fmt(nonHotels.length-known.length)} unknown spatial results excluded. Privacy leeway +${leeway()}%; parcel tolerance ${parcelTolerance().toFixed(2)} m; edge buffer ${edgeBuffer()} m.`
    :'Spatial data unavailable; no likely-unlicensed classification calculated.';
  $('showLikelyUnlicensed').textContent=`Likely unlicensed: ${fmt(likely)} · Show listings + heatmap`;
  $('showLikelyUnlicensed').disabled=!spatial.available||!likely;
  $('revenueLikelyStats').textContent=spatial.available?`Potentially unlicensed: ${fmt(likely)} · View screening calculation`:'Potentially unlicensed · Spatial data unavailable';
}
function showStatsOnMap(kind) {
  // Keep calculation settings while clearing unrelated filters so counts reconcile.
  const preserved={includeLargeOverCapacity:$('includeLargeOverCapacity').checked,excludeMultipleOverCapacity:$('excludeMultipleOverCapacity').checked,
    edgeBuffer:$('edgeBuffer').value,leeway:$('leeway').value,nearTolerance:$('nearTolerance').checked};
  for(const control of document.querySelectorAll('#filters input')){
    if(control.type==='checkbox')control.checked=control.defaultChecked;else control.value=control.defaultValue;
  }
  for(const control of document.querySelectorAll('#filters select'))control.selectedIndex=0;
  for(const [id,value] of Object.entries(preserved))if(typeof value==='boolean')$(id).checked=value;else $(id).value=value;
  selectedHost='';selectedHostMetric='';selectedPartyCombo='';selectedPartyRequireCapacity=false;$('hostSearch').value='';
  $('scopeOnly').checked=true;$('over').value=kind==='occupancy'?'1':'0';
  $('likely').checked=kind==='likely';$('surplusHeatmap').checked=kind==='likely';
  $('violationStatsDialog').close();$('revenueDialog').close();popup?.remove();selectedListing=null;
  if($('filters').classList.contains('collapsed'))$('toggleFilters').click();
  update();fitVisible();
}
function filterListings() {
  const query=$('search').value.trim().toLowerCase(), selected=[...document.querySelectorAll('.amenity:checked')].map(e=>e.value);
  const communityStatuses=[...document.querySelectorAll('.community-status:checked')].map(e=>e.value);
  const minimum=Number($('over').value), radius=Number($('radius').value);
  const rentalTypes=new Set([...document.querySelectorAll('.rental-type:checked')].map(input=>input.value));
  const matching=requireCapacity=>listings.filter(l=>l.point && (!query||l.search.includes(query)) && (!selectedHost||hostKey(l)===selectedHost)
    && (!$('scopeOnly').checked||Spatial.inScope(l,edgeBuffer()))
    && (!$('likely').checked||likelyUnlicensed(l))
    && (!$('nearOnly').checked||(typeof l.nearest_licensed_parcel_m==='number'&&l.nearest_licensed_parcel_m<=9.144))
    && communityStatuses.includes(communityStatus(l))
    && (!minimum||(overCapacityFlag(l)&&l.over_capacity>=minimum))
    && (!$('partyOnly').checked||(l.party_house||overCapacityFlag(l)))
    && (!requireCapacity||(selectedHost&&['party','combo'].includes(selectedHostMetric)&&overCapacityFlag(l)))
    && (selectedHostMetric!=='combo'||amenityCombo(l)===selectedPartyCombo)
    && (!selected.length||($('allAmenities').checked?selected.every(k=>l.amenities[k]):selected.some(k=>l.amenities[k])))
    && rentalTypes.has(l.rental_type||'')
    && (!$('outside').checked||outsideCoverage(l,radius)));
  return matching(selectedPartyRequireCapacity);
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
  BrowserState.clear();
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
  if(l.likely_hotel) return '#f97316';
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
  BrowserState.schedule();
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
  updateViolationStats();
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
  // One equal-weight observation per visible flagged listing, anchored to its marker.
  // Grid-cell centers can lie far from rentals, so they never seed the red heatmap.
  const heatListings=[...new Map(visible.filter(likelyUnlicensed).map(l=>[l.listing_id,l])).values()];
  sourceData('surplus',collection(heatListings.map(l=>feature({type:'Point',coordinates:l.displayPoint||l.point},
    {id:l.listing_id,weight:1,radius_scale:radius/550}))));
  sourceData('deficit',collection([]));
  if(map.getLayer('surplus-heatmap'))map.setPaintProperty('surplus-heatmap','heatmap-opacity',intensity);
  layerVisibility(['balance-fill','balance-outline'],$ ('difference').checked);
  layerVisibility(['surplus-heatmap'],$ ('surplusHeatmap').checked&&radius>0);
  layerVisibility(['deficit-heatmap'],false);
  const listingCount=new Set(listings.filter(l=>!l.likely_hotel&&l.point&&l.cell_id&&Spatial.inScope(l,edgeBuffer())).map(l=>l.listing_id)).size;
  const propertyCount=new Set(permits.filter(p=>p.status==='current'&&p.point&&p.cell_id&&Spatial.inScope(p,edgeBuffer())).map(p=>normalizeParcel(p.parcel)||`record:${p.id}`)).size;
  $('balanceSummary').textContent=`${listingCount.toLocaleString()} non-hotel listing locations · ${propertyCount.toLocaleString()} distinct current-permit properties. ${heatListings.length.toLocaleString()} visible likely-unlicensed listings seed the red heatmap. Grid counts are independent of display filters.`;
}
function updateHosts() {
  $('clearHost').classList.toggle('filter-attention',Boolean(selectedHost));
  $('clearHost').setAttribute('aria-pressed',String(Boolean(selectedHost)));
  const groups=new Map();
  for(const l of visible) {const key=hostKey(l);if(!groups.has(key))groups.set(key,{name:l.host_name||'Unknown host',items:[]});groups.get(key).items.push(l);}
  // Keep the active host's controls even when scope or another filter hides every result.
  if(selectedHost&&!groups.has(selectedHost)){
    const identity=listings.find(l=>hostKey(l)===selectedHost);
    if(identity)groups.set(selectedHost,{name:identity.host_name||'Unknown host',items:[]});
  }
  const hostQuery=$('hostSearch').value.trim().toLowerCase();
  const metric=group=>hostSortKey==='likely'?group.items.filter(likelyUnlicensed).length:hostSortKey==='party'?group.items.filter(l=>l.party_house).length:group.items.length;
  const filteredGroups=[...groups].filter(([key,group])=>key===selectedHost||group.name.toLowerCase().includes(hostQuery)).sort((a,b)=>{
    const comparison=hostSortKey==='host'?a[1].name.localeCompare(b[1].name):metric(a[1])-metric(b[1])||a[1].name.localeCompare(b[1].name);
    return comparison*(hostSortDirection==='asc'?1:-1);
  });
  $('hostCount').textContent=`(${filteredGroups.length})`;
  $('hosts').replaceChildren();
  const heading=document.createElement('div');heading.className='host-grid host-column-labels';
  for(const [key,label] of [['host','Host'],['total','Total'],['likely','Possibly unlicensed'],['party','Party / cap']]){
    const button=document.createElement('button');button.type='button';button.dataset.sortKey=key;button.className='host-sort'+(hostSortKey===key?' active':'');button.setAttribute('aria-sort',hostSortKey===key?(hostSortDirection==='asc'?'ascending':'descending'):'none');
    button.textContent=`${label}${hostSortKey===key?(hostSortDirection==='asc'?' ▲':' ▼'):''}`;
    button.onclick=()=>{if(hostSortKey===key)hostSortDirection=hostSortDirection==='asc'?'desc':'asc';else{hostSortKey=key;hostSortDirection=key==='host'?'asc':'desc';}updateHosts();};heading.append(button);
  }
  $('hosts').append(heading);
  for(const [key,g] of filteredGroups) {
    const row=document.createElement('div');row.className='host-row host-grid';
    const name=document.createElement('button');name.className='host-name'+(key===selectedHost?' selected':'');name.textContent=g.name;const identity=g.items[0]||listings.find(l=>hostKey(l)===key);name.title=identity.host_user_id?`Host ID ${identity.host_user_id}`:identity.host_profile_url||g.name;name.onclick=()=>{selectedHost=key;selectedHostMetric='total';selectedPartyRequireCapacity=false;$('partyOnly').checked=false;update();fitVisible();};
    const total=document.createElement('button');total.className='host-count'+(selectedHost===key&&selectedHostMetric==='total'?' filter-active':'');total.textContent=g.items.length;total.title='Filter map to this host';total.onclick=()=>{selectedHost=key;selectedHostMetric='total';selectedPartyRequireCapacity=false;$('partyOnly').checked=false;update();fitVisible();};
    const unlicensed=document.createElement('button');unlicensed.className='host-metric'+(selectedHost===key&&selectedHostMetric==='likely'?' filter-active':'');unlicensed.textContent=g.items.filter(likelyUnlicensed).length;unlicensed.title='Filter this host to possibly unlicensed locations';
    unlicensed.onclick=()=>{selectedHost=key;selectedHostMetric='likely';selectedPartyRequireCapacity=false;$('partyOnly').checked=false;$('likely').checked=true;update();fitVisible();};
    const party=document.createElement('button');party.className='host-metric'+(selectedHost===key&&selectedHostMetric==='party'?' filter-active':'');const partyCount=g.items.filter(l=>l.party_house).length,capCount=g.items.filter(overCapacityFlag).length;
    const cap=document.createElement('span');cap.className='host-cap-number';cap.textContent=capCount;
    party.append(document.createTextNode(`${partyCount} / `),cap);
    party.title=`${partyCount} party-keyword listings / ${capCount} over-capacity listings. Click to filter; Require over capacity starts checked.`;
    party.setAttribute('aria-label',`${g.name}: ${partyCount} party-keyword listings, ${capCount} over-capacity listings`);
    party.onclick=()=>{selectedHost=key;selectedHostMetric='party';selectedPartyCombo='';selectedPartyRequireCapacity=true;$('partyOnly').checked=true;update();fitVisible();$('partyDisclaimer').showModal();};
    row.append(name,total,unlicensed,party);$('hosts').append(row);
    if(key===selectedHost&&['party','combo'].includes(selectedHostMetric)) {
      const combinations=new Map();
      for(const listing of listings.filter(item=>hostKey(item)===key&&(item.party_house||overCapacityFlag(item)))) {
        const combo=amenityCombo(listing);if(combo)combinations.set(combo,(combinations.get(combo)||0)+1);
      }
      const comboRow=document.createElement('div');comboRow.className='host-combos';
      const capacityLabel=document.createElement('label');capacityLabel.className='host-capacity-filter';const capacityToggle=document.createElement('input');capacityToggle.type='checkbox';capacityToggle.checked=selectedPartyRequireCapacity;capacityToggle.onchange=()=>{selectedPartyRequireCapacity=capacityToggle.checked;update();};capacityLabel.append(capacityToggle,document.createTextNode('Require over capacity'));comboRow.append(capacityLabel);
      if(!g.items.length){
        const note=document.createElement('p');note.className='host-capacity-note';note.setAttribute('role','status');
        note.textContent='No listings match all current filters. This host and its controls remain selected. Change the combination, occupancy requirement, rental types, or analysis-area filter.';
        comboRow.append(note);
        const comboListings=listings.filter(l=>hostKey(l)===key&&l.point&&(selectedHostMetric!=='combo'||amenityCombo(l)===selectedPartyCombo));
        if($('scopeOnly').checked&&comboListings.length&&comboListings.every(l=>!Spatial.inScope(l,edgeBuffer()))){
          note.textContent='This combination is outside the selected analysis area. The analysis-area filter is hiding its listings.';
          const outsideButton=document.createElement('button');outsideButton.type='button';outsideButton.className='show-outside-host';outsideButton.textContent='Include listings outside analysis area';
          outsideButton.onclick=()=>{$('scopeOnly').checked=false;update();fitVisible();};comboRow.append(outsideButton);
        }
      }
      const largeCapacityLabel=document.createElement('label');largeCapacityLabel.className='host-capacity-filter';const largeCapacityToggle=document.createElement('input');largeCapacityToggle.type='checkbox';largeCapacityToggle.checked=$('includeLargeOverCapacity').checked;largeCapacityToggle.onchange=()=>{$('includeLargeOverCapacity').checked=largeCapacityToggle.checked;update();};largeCapacityLabel.append(largeCapacityToggle,document.createTextNode('Include >5-bedroom over-capacity listings'));comboRow.append(largeCapacityLabel);
      for(const [combo,count] of [...combinations].sort((a,b)=>a[0].localeCompare(b[0]))) {
        const button=document.createElement('button');button.type='button';button.className='host-combo'+(selectedHostMetric==='combo'&&selectedPartyCombo===combo?' selected':'');
        button.innerHTML=`${combo.split('|').map(amenityIconHtml).join(' ')} ${esc(count)}`;
        button.title=`${count} host listing${count===1?'':'s'} with this exact amenity combination, before other filters`;
        button.dataset.combo=combo;
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
    const amenityKeys=Object.keys(l.amenities).filter(k=>(!selected.length||selected.includes(k))&&(icons[k]||customAmenityIcons[k]));
    const values=[...new Set(['🥳',...amenityKeys])];
    const el=document.createElement('div');el.className='emoji-marker';el.setAttribute('aria-hidden','true');
    values.forEach((icon,i)=>{const s=document.createElement('span');if(icon==='🥳')s.textContent=icon;else if(customAmenityIcons[icon]){const img=document.createElement('img');img.className='amenity-custom-icon marker-icon';img.src=customAmenityIcons[icon];img.alt='';s.append(img);}else s.textContent=icons[icon];const angle=-Math.PI/2+i*2*Math.PI/values.length;s.style.left=`${Math.cos(angle)*32}px`;s.style.top=`${Math.sin(angle)*32}px`;el.append(s);});
    el.style.pointerEvents='auto';el.addEventListener('click',event=>{event.stopPropagation();showListing(l);});
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
  try {if(BrowserState.accepted()){theme=localStorage.getItem('stvr-doorman-theme')||'light';dismissed=localStorage.getItem('stvr-doorman-disclaimer-dismissed')==='yes';}} catch {}
  const applyTheme=value=>{document.body.classList.toggle('dark-mode',value==='dark');$('themeToggle').checked=value==='dark';$('themeToggle').setAttribute('aria-pressed',String(value==='dark'));};
  applyTheme(theme);
  $('themeToggle').addEventListener('change',()=>{const value=$('themeToggle').checked?'dark':'light';applyTheme(value);try{if(BrowserState.accepted())localStorage.setItem('stvr-doorman-theme',value);}catch{}});
  const disclaimer=$('firstVisitDisclaimer');
  disclaimer.addEventListener('cancel',event=>event.preventDefault());
  $('dismissFirstVisit').onclick=()=>{try{if(BrowserState.accepted())localStorage.setItem('stvr-doorman-disclaimer-dismissed','yes');}catch{}disclaimer.close();};
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
const matchLabels={license_number:'License number',owner_name:'Owner / host name',owner_first_name:'Owner / host first name',owner_nickname:'Owner / host nickname',permit_owner_name:'Permit owner / host name',permit_owner_first_name:'Permit owner / host first name',permit_owner_nickname:'Permit owner / host nickname',distance:'Distance only'};
function associationOrder(a,b){const rank=m=>m.type==='license_number'?0:m.type==='distance'?2:1;return rank(a)-rank(b)||(a.distance_m??Infinity)-(b.distance_m??Infinity)||String(a.listing_id||a.parcel||'').localeCompare(String(b.listing_id||b.parcel||''));}
function hotelReportsHtml(listing){return (listing.hotel_reports||[]).map(r=>`<p><b>${r.source==='user_submitted'?'User submitted hotel':'Manually marked hotel'}</b>${r.hotel_name?` · ${esc(r.hotel_name)}`:''}${r.address?`<br>User-submitted address (not verified): ${esc(r.address)}`:''}${/^https?:\/\//i.test(r.proof_url||'')?`<br><a href="${esc(r.proof_url)}" target="_blank" rel="noopener">Hotel proof ↗</a>`:''}${/^https?:\/\//i.test(r.source_url||'')?`<br><a href="${esc(r.source_url)}" target="_blank" rel="noopener">Public submission source ↗</a>`:''}</p>`).join('');}
function matchBadge(m){const color=m.type==='license_number'?'#166534':m.type==='distance'?'#475569':m.type.includes('nickname')?'#7e22ce':'#1d4ed8';return `<span style="background:${color};color:white;padding:2px 5px;border-radius:4px">${esc(matchLabels[m.type]||m.type)}</span>`;}
async function showProperty(property, position){
  const canonical=licensedParcels?.features.find(f=>normalizeParcel(f.properties.parcel)===normalizeParcel(property.parcel))?.properties||property;
  const parcel=String(canonical.parcel||''), records=permits.filter(p=>parcel?normalizeParcel(p.parcel)===normalizeParcel(parcel):p.id===property.id);
  const primary=records.find(p=>p.status==='current')||records[0];
  popup?.remove();const current=new maplibregl.Popup({maxWidth:'400px'}).setLngLat(position).setHTML(`<h3>${primary?'License record':'Property record'}</h3><p><b>${esc(primary?.address||canonical.address)}</b>${primary?`<br><span class="badge ${esc(primary.status)}">${esc(primary.status)}</span> · ${esc(primary.permit_number||'Permit number unavailable')}<br>${esc(primary.type)}`:''}</p>${records.length?`<details><summary>License details (${records.length})</summary>${records.map(permitCard).join('')}</details>`:''}<details><summary>Parcel details</summary><p>${esc(canonical.address)}<br>Parcel: ${esc(parcel)}<br>Property owner: ${esc(canonical.owner||'Unavailable')}</p></details>${records.length?`<details><summary>Possibly associated listings</summary><p class="small muted">Auto matched, not verified. Name matches first, then distance-only candidates, nearest first. All candidates require verification.</p><div data-associations style="max-height:260px;overflow-y:auto">Loading…</div></details>`:''}<details><summary>Forms</summary><button type="button" data-complaint>Complaint form (with evidence)</button></details>`).addTo(map);popup=current;
  bindComplaintButton(current.getElement(),canonical.address,primary?.point||canonical.point||(Array.isArray(position)?position:[position.lng,position.lat]),'');
  const container=current.getElement().querySelector('[data-associations]');
  if(!container)return;
  try{
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(parcel)),key=Array.from(new Uint8Array(digest)).map(v=>v.toString(16).padStart(2,'0')).join('').slice(0,2);
    const manifest=await getJSON('data/property_matches/manifest.json');
    const rows=manifest.buckets.includes(key)?(await getJSON(`data/property_matches/${key}.json`))[parcel]||[]:[];
    container.replaceChildren();const seen=new Set();
    for(const row of rows.sort(associationOrder)){if(seen.has(row.listing_id))continue;seen.add(row.listing_id);const listing=listings.find(l=>l.listing_id===row.listing_id);if(!listing)continue;const button=document.createElement('button');button.className='license-listing-candidate';button.innerHTML=`${matchBadge(row)}<strong>${esc(listing.title||listing.listing_id)}</strong><span>Host: ${esc(listing.host_name||'Unknown')} · ${row.distance_m===null?'Distance unavailable':row.distance_m.toFixed(1)+' m to parcel boundary'}</span>`;button.onclick=()=>showListing(listing);container.append(button);if(listing.hotel_reports?.length){const evidence=document.createElement('div');evidence.innerHTML=hotelReportsHtml(listing);container.append(evidence);}}
    if(!seen.size)container.textContent='No candidates found.';
  }catch(e){container.textContent=`Could not load candidates: ${e.message}`;}
}
async function renderListingAssociations(listing,container){
  const rows=[...(listing.preliminary_matches||[])];container.textContent='Loading nearby properties…';
  try{for(const p of await Reporting.loadCandidates(listing)){if(!rows.some(m=>normalizeParcel(m.parcel)===normalizeParcel(p.parcel)))rows.push({...p,type:'distance'});}}catch(e){container.textContent=`Nearby properties unavailable: ${e.message}`;return;}
  container.replaceChildren();for(const row of rows.sort(associationOrder)){const button=document.createElement('button');button.className='license-listing-candidate';button.innerHTML=`${matchBadge(row)}<strong>${esc(row.address)}</strong><span>Owner: ${esc(row.owner||'Unavailable')} · ${row.distance_m==null?'Distance unavailable':row.distance_m.toFixed(1)+' m to parcel boundary'}</span>`;button.onclick=()=>showProperty(row,permits.find(p=>normalizeParcel(p.parcel)===normalizeParcel(row.parcel))?.point||listing.point);container.append(button);}if(!rows.length)container.textContent='No candidates found.';
}
function showListing(l, nearbyPermit=null) {
  if(matchMedia('(max-width: 700px)').matches){
    const filters=$('filters'),hosts=document.querySelector('.hosts'),toggle=$('toggleFilters');
    filters.classList.add('collapsed');hosts.querySelector('details').open=false;
    $('mobilePanels').classList.remove('panel-expanded');
    toggle.textContent='Show';toggle.setAttribute('aria-expanded','false');
  }
  popup?.remove();
  selectedListing=l;updatePrivacy();
  const privacy=l.privacy_radius_meters===null?'Unknown':`${l.privacy_radius_meters} m`;
  const listingSource=`<a href="${esc(l.url)}" target="_blank" rel="noopener">Airbnb.com listing</a>`;
  let html=`<h3>${esc(l.title||'Airbnb listing')}</h3><span class="badge ${esc(communityStatus(l))}">${esc(communityStatusNames[communityStatus(l)])}</span><p><a href="${esc(l.url)}" target="_blank" rel="noopener">Open Airbnb listing ↗</a></p><p><b>Host:</b> <button type="button" class="popup-host-select" data-select-host>${esc(l.host_name||'Unknown')}</button><br><b>Guests:</b> ${esc(l.guests??'Unknown')} · <b>Bedrooms:</b> ${esc(l.bedrooms??'Unknown')}<br><b>Capacity:</b> ${esc(l.allowed_guests??"Unknown (bedrooms missing)")} guests${overCapacityFlag(l)?`<br><b>Over capacity:</b> <a href="https://www.nashville.gov/departments/codes/short-term-rentals/operation-rules-and-requirements" target="_blank" rel="noopener">${esc(l.over_capacity)} guests · Nashville rules ↗</a>`:''}<br><b>Airbnb privacy radius:</b> ${esc(privacy)}<br><b>Approximate location:</b> ${esc(l.approximate_address||l.location_name||'Unknown')}</p>`;
  if(l.hotel_reports?.length)html+=`<p><b style="color:#c2410c">${l.hotel_source==='user_submitted'?'User submitted hotel':'Manually marked hotel'}</b></p><details><summary>Hotel reports and proof</summary>${hotelReportsHtml(l)}</details>`;
  const detectedCount=Number(l.detected_permit_count??detectedPermitList(l).length);
  const dualCapacity=Boolean(l.dual_license_capacity)||detectedCount===2;
  const titleMentionsTwo=/\btwo\b/i.test(l.title||'');
  if(dualCapacity||titleMentionsTwo)html+=`<details><summary>Capacity estimate caveat</summary><p class="small spatial-warning"><b>Capacity estimate caveat:</b> ${dualCapacity?'Two permit numbers were detected in listing text; the estimate treats them as two units, splits bedrooms between units, and allows up to 12 guests per unit.':'The title mentions “two”, which may refer to multiple units.'} This is an unverified screening assumption, not confirmation of separate licensed units. Please verify the actual unit and bedroom configuration.</p></details>`;
  if(Number(l.bedrooms)>5&&(Number(l.over_capacity)||0)>0)html+=`<p class="small muted">This listing has more than 5 bedrooms. Its over-capacity flag is excluded from filters by default; enable “Include listings with over 5 bedrooms in over-capacity results” to include it.</p>`;
  if(detectedPermitList(l).length) html+=`<p><b>Detected listing permit numbers:</b> ${detectedPermitList(l).map(esc).join(', ')}<br><span class="small muted">These are text matches from the listing and are not the canonical license list.</span></p>`;
  if(actualPermitList(l).length) html+=`<p><b>Actual matched permit records:</b> ${actualPermitList(l).map(esc).join(', ')}</p>`;
  const currentIds=new Set(permits.filter(p=>p.status==='current').map(p=>p.id));
  const nameCandidate=(l.preliminary_matches||[]).find(m=>m.type!=='distance'&&[m.permit_id,...(m.permit_ids||[])].some(id=>currentIds.has(id)));
  html+=nameCandidate?`<p><b>Preliminary permitted-property match:</b><br>${matchBadge(nameCandidate)} ${esc(nameCandidate.address)}<br><span class="small muted">Auto matched, not verified.</span></p>`:`<p><b>Nearest permitted parcel:</b> ${typeof l.nearest_licensed_parcel_m==='number'?l.nearest_licensed_parcel_m.toFixed(1)+' m':'Unknown'}</p>`;
  html+=`<details><summary>Property / license candidates</summary><p class="small muted">Auto matched, not verified. Name matches first, then distance-only candidates, nearest first within each group. Candidates require later verification.</p><div data-property-associations style="max-height:240px;overflow-y:auto"></div></details>`;
  if(nearbyPermit)html+=`<details><summary>Nearby permit for review</summary><p class="small muted">Selected from permit locations within 550 m. This is not a confirmed match.</p>${permitCard(nearbyPermit)}</details>`;
  const overlap=Spatial.overlap(l,leeway(),parcelTolerance()), effective=Spatial.effectiveRadius(l,leeway());
  if(l.likely_hotel)html+=`<details><summary>Hotel screening evidence</summary><p class="hotel-notice"><b>Likely hotel / resort</b> · Excluded from potentially unlicensed counts.<br>${(l.hotel_evidence||[]).map(e=>esc(e.field)+': '+esc(e.evidence)).join('<br>')}</p></details>`;
  const spatialText=l.likely_hotel?'Likely hotel: excluded from potentially unlicensed screening':!spatial.available?'Spatial data unavailable':!Spatial.inScope(l,edgeBuffer())?'Outside the selected analysis area':overlap===null?'Unknown: privacy radius or parcel geometry missing':overlap?'Privacy circle reaches a green permitted parcel':'⚠️ Likely unlicensed location: privacy circle does not reach any current-permit parcel';
  html+=`<details><summary>Parcel-overlap screening</summary><p class="${likelyUnlicensed(l)?'spatial-warning':'small'}"><b>Parcel-overlap screening:</b> ${esc(spatialText)}<br>Screening radius with +${leeway()}% leeway: ${effective===null?'Unknown':effective.toFixed(1)+' m'}<br>Extra parcel tolerance: ${parcelTolerance().toFixed(2)} m${parcelTolerance()?' (10 yards)':''}<br>Nearest permitted parcel: ${typeof l.nearest_licensed_parcel_m==='number'?l.nearest_licensed_parcel_m.toFixed(1)+' m':'Unknown'}<br><span class="small muted">${l.privacy_radius_meters>0?'The map circle uses the radius provided with this Airbnb listing.':'The selected map circle is a 15 m display fallback; it is not an Airbnb-provided radius and does not change screening.'} This geographic screen does not verify license status.</span></p></details>`;
  if(l.matched_permits.length) html+='<details><summary>Direct permit-number matches</summary>'+l.matched_permits.map(permitCard).join('')+'</details>';
  else html+='<details><summary>Permit-number matching</summary><p class="small muted">No direct permit-number match. This does not establish whether a license exists at this address.</p></details>';
  if(l.party_house) html+=`<p><b>🎉 Party/event keyword matches:</b> ${Object.keys(l.amenities).map(amenityIconHtml).join(' ')}</p><details><summary>Keyword evidence</summary>${Object.entries(l.amenities).map(([k,v])=>`<p>${amenityIconHtml(k)} ${esc(k.replaceAll('_',' '))}<br><span class="evidence">${esc(v.evidence)}<br>Source: ${listingSource}</span></p>`).join('')}</details>`;
  if(l.permit_evidence.length) html+=`<details><summary>Permit-number evidence</summary>${l.permit_evidence.map(e=>`<p><b>${esc(e.number)}</b> (${esc(e.method)})<br><span class="evidence">${esc(e.evidence)}<br>Source: ${listingSource}</span></p>`).join('')}</details>`;
  html+='<details><summary>Data and capacity rules</summary>';
  html+=dualCapacity?'<p class="small muted">Two-unit screening estimate: min(2 × total bedrooms + 8, 24), assuming bedrooms split evenly and each unit gets +4 guests. The detected numbers may be inaccurate and do not confirm separate licensed units. Saved listing data; approximate Airbnb location. <a href="about_data.html">Data and Nashville rules</a></p>':'<p class="small muted">Capacity = min(2 × bedrooms + 4, 12), using advertised bedrooms. Missing bedrooms: only excess above 12 can be flagged. Saved listing data; approximate Airbnb location. <a href="about_data.html">Data and Nashville rules</a></p>';
  html+='</details><details><summary>Forms and corrections</summary><div class="report-actions"><button type="button" data-complaint>Complaint form (with evidence)</button><button type="button" data-report="location">Suggest location correction</button><button type="button" data-report="license">Suggest license correction</button><button type="button" data-report="address">Suggest address correction</button><a data-hotel-form target="_blank" rel="noopener">Report this listing as a hotel ↗</a></div></details>';
  popup=new maplibregl.Popup({maxWidth:'380px',className:'listing-popup-centered'}).setLngLat(l.displayPoint||l.point).setHTML(html).addTo(map);
  const hotelForm=new URL('https://docs.google.com/forms/d/e/1FAIpQLScjN7eHKBjY3c8Iew6F08WYgHN30ozXlv9NHg2lpfBrABGXdg/viewform');hotelForm.searchParams.set('usp','pp_url');hotelForm.searchParams.set('entry.225332467',l.url);popup.getElement().querySelector('[data-hotel-form]').href=hotelForm.toString();
  popup.getElement().querySelector('[data-select-host]').onclick=()=>{pendingHostKey=hostKey(l);$('hostPromptName').textContent=l.host_name||'Unknown host';$('hostConfirmDialog').showModal();};
  renderListingAssociations(l,popup.getElement().querySelector('[data-property-associations]'));
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
  const previousTypes=new Map([...document.querySelectorAll('.rental-type')].map(input=>[input.value,input.checked]));
  $('rentalTypeOptions').replaceChildren(...[...new Set(listings.map(l=>l.rental_type||''))].sort().map(type=>{
    const label=document.createElement('label'),input=document.createElement('input');
    input.type='checkbox';input.className='rental-type';input.value=type;input.defaultChecked=true;
    input.checked=previousTypes.has(type)?previousTypes.get(type):true;
    label.append(input,document.createTextNode(`${type||'Unknown rental type'} (${listings.filter(l=>(l.rental_type||'')===type).length.toLocaleString()})`));return label;
  }));
  const permitStatusCounts=new Map();
  for(const permit of permits){const status=String(permit.status||'unknown').toLowerCase();permitStatusCounts.set(status,(permitStatusCounts.get(status)||0)+1);}
  const permitStatusLabel=status=>status.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());
  $('buildStatus').textContent=`${report.mapped_listings.toLocaleString()} listings`;
  const currentPermitCount=permitStatusCounts.get('current')||0;
  $('currentPermitCount').textContent=`Current permits ${currentPermitCount.toLocaleString()}`;
  const hotelCount=listings.filter(l=>l.likely_hotel).length;
  const mappedHotelCount=listings.filter(l=>l.likely_hotel&&l.point).length;
  const nonHotelCount=report.mapped_listings-mappedHotelCount;
  $('hotelCount').textContent=`Likely hotels ${hotelCount.toLocaleString()}`;
  $('hotelCount').title=`${mappedHotelCount.toLocaleString()} mapped; ${(hotelCount-mappedHotelCount).toLocaleString()} without coordinates. Excluded from STR screening.`;
  const listingPermitDifference=nonHotelCount-currentPermitCount;
  const estimatedShortfall=Math.max(0,listingPermitDifference)*ESTIMATED_STVR_FEE;
  $('potentialRevenueButton').textContent=`Potential revenue shortfall ${estimatedShortfall.toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0})}`;
  $('revenueEquation').textContent=`${nonHotelCount.toLocaleString()} mapped non-hotel listings (${mappedHotelCount.toLocaleString()} likely hotels excluded) − ${currentPermitCount.toLocaleString()} current permit records = ${listingPermitDifference.toLocaleString()} potential unaccounted listings. ${Math.max(0,listingPermitDifference).toLocaleString()} × $${ESTIMATED_STVR_FEE} = ${estimatedShortfall.toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0})} potential shortfall.`;
  $('revenueSnapshotNote').textContent=`Snapshot date: ${report.as_of}. This arithmetic assumes one permit per mapped non-hotel listing and a $${ESTIMATED_STVR_FEE} fee per permit.`;
  $('permitInfoDate').textContent=`Permit snapshot as of ${report.as_of}.`;
  const otherStatuses=[['grand_total',permits.length],...[...permitStatusCounts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))];
  $('otherPermitStatuses').replaceChildren(...otherStatuses.map(([status,count])=>{const row=document.createElement('p');row.className='permit-status-row'+(status==='current'?' permit-current':status==='grand_total'?' permit-grand-total':'');const label=document.createElement('span');label.textContent=status==='grand_total'?'Grand total · all permit records':status==='current'?'Current permits':permitStatusLabel(status);const value=document.createElement('strong');value.textContent=count.toLocaleString();row.append(label,value);return row;}));
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
  map.addLayer({id:'surplus-heatmap',type:'heatmap',source:'surplus',layout:{visibility:'none'},paint:{'heatmap-weight':['get','weight'],'heatmap-radius':['interpolate',['linear'],['zoom'],9,['*',['get','radius_scale'],4.5],11,['*',['get','radius_scale'],18],13,['*',['get','radius_scale'],72],15,['*',['get','radius_scale'],288],18,['*',['get','radius_scale'],2304]],'heatmap-intensity':1,'heatmap-opacity':.15,'heatmap-color':['interpolate',['linear'],['heatmap-density'],0,'rgba(255,255,255,0)',.02,'rgba(254,202,202,.7)',.08,'rgba(239,68,68,.85)',.22,'rgba(185,28,28,.92)',1,'rgba(127,29,29,.96)']}});
  map.addLayer({id:'deficit-heatmap',type:'heatmap',source:'deficit',layout:{visibility:'none'},paint:{'heatmap-weight':['get','weight'],'heatmap-radius':['interpolate',['linear'],['zoom'],9,['*',['get','radius_scale'],4.5],11,['*',['get','radius_scale'],18],13,['*',['get','radius_scale'],72],15,['*',['get','radius_scale'],288],18,['*',['get','radius_scale'],2304]],'heatmap-intensity':1,'heatmap-opacity':.15,'heatmap-color':['interpolate',['linear'],['heatmap-density'],0,'rgba(255,255,255,0)',.02,'rgba(237,247,237,.65)',.08,'rgba(205,232,205,.75)',.22,'rgba(151,201,151,.85)',1,'rgba(112,168,112,.9)']}});
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
    const p=e.features[0].properties;popup?.remove();popup=new maplibregl.Popup({maxWidth:'330px'}).setLngLat(e.lngLat).setHTML(`<h3>Listings − licenses</h3><p>500 × 500 m cell ${esc(p.cell_id)}</p><p><b>${p.listings}</b> listing locations<br><b>${p.permits}</b> current permit records<br><b>${p.difference>0?'+':''}${p.difference}</b> listings minus permits</p><p class="small muted">Likely hotels excluded; remaining records in the selected area counted once by point location. This is a geographic estimate; Airbnb locations can be displaced. A surplus does not identify which listings lack a permit.</p>`).addTo(map);
  });
  map.on('click','listing-markers',e=>{const l=listings.find(l=>l.listing_id===e.features[0].properties.id);if(l)showListing(l);});
  map.on('click','listing-labels',e=>{const l=listings.find(l=>l.listing_id===e.features[0].properties.id);if(l)showListing(l);});
  map.on('click','privacy-line',()=>{if(selectedListing)showListing(selectedListing);});
  const listingClick=e=>map.queryRenderedFeatures(e.point,{layers:['listing-markers','listing-labels','warning-markers','privacy-line']}).length;
  map.on('click','permit-markers',e=>{if(listingClick(e))return;const p=permits.find(p=>p.id===e.features[0].properties.id);if(p)showProperty(p,p.point);});
  map.on('click','parcel-fill',e=>{if(listingClick(e)||map.queryRenderedFeatures(e.point,{layers:['permit-markers']}).length)return;showProperty(e.features[0].properties,e.lngLat);});
  map.on('click','nearby-parcel-fill',e=>{if(listingClick(e)||map.queryRenderedFeatures(e.point,{layers:['permit-markers','parcel-fill']}).length)return;showProperty(e.features[0].properties,e.lngLat);});
  for(const id of ['listing-markers','permit-markers','parcel-fill']){map.on('mouseenter',id,()=>map.getCanvas().style.cursor='pointer');map.on('mouseleave',id,()=>map.getCanvas().style.cursor='');}
  map.on('moveend',()=>{BrowserState.schedule();updateSymbols();updateAddresses();Reporting.loadViewport(map);});
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
  BrowserState.setup();
  setupAppearanceAndDisclaimer();
  try {
    [listings,permits,report]=await Promise.all(['listings','permits','build_report'].map(n=>getJSON(`data/${n}.json`)));
    try{parcelManifest=await getJSON('data/parcels/manifest.json');}catch{parcelManifest={available:false};}
    if(parcelManifest?.available)licensedParcels=await getJSON('data/licensed_parcels.geojson');
    if(report.spatial?.available)spatial=await getJSON('data/spatial.json');
    if(!spatial.available){for(const id of ['scopeOnly','likely','warningSymbols','difference','surplusHeatmap','heatRadius','heatIntensity']){$(id).checked=false;$(id).disabled=true;}}
    prepareData();
    const savedView=BrowserState.restore();
    map=new maplibregl.Map({container:'map',center:[-86.7816,36.1627],zoom:11,...savedView,style:{version:8,glyphs:'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',sources:{osm:{type:'raster',tiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],tileSize:256,maxzoom:19,attribution:'© OpenStreetMap contributors'}},layers:[{id:'basemap',type:'raster',source:'osm'}]}});
    map.addControl(new maplibregl.NavigationControl(),'top-right');map.addControl(new maplibregl.ScaleControl());
    map.on('load',addSourcesAndLayers);
    for(const el of document.querySelectorAll('#filters input:not(.rental-type),#filters select'))el.addEventListener(el.type==='search'?'input':'change',()=>{updateExploreClearButton();clearTimeout(refreshTimer);refreshTimer=setTimeout(update,el.type==='search'?180:0);});
    $('rentalTypes').addEventListener('toggle',()=>{$('rentalTypeHint').textContent=$('rentalTypes').open?'Click to hide':'Click to expand';});
    $('rentalTypeOptions').addEventListener('change',update);
    for(const [id,checked] of [['rentalTypesAll',true],['rentalTypesNone',false]])$(id).onclick=()=>{
      for(const input of document.querySelectorAll('.rental-type'))input.checked=checked;update();
    };
    setupResponsivePanels();
    // Footer wraps as counts and viewport widths change; reserve its actual height.
    new ResizeObserver(()=>{const height=$('statusbar').getBoundingClientRect().height;
      document.documentElement.style.setProperty('--map-footer-height',height+'px');map.resize();
    }).observe($('statusbar'));
    $('clearExploreFilters').onclick=resetExploreFilters;
    $('hostSearch').addEventListener('input',updateHosts);
    $('clearHost').onclick=()=>{selectedHost='';selectedHostMetric='';selectedPartyCombo='';selectedPartyRequireCapacity=false;$('likely').checked=false;$('partyOnly').checked=false;update();};
    $('currentPermitCount').onclick=()=>$('otherPermitDialog').showModal();$('closeOtherPermits').onclick=()=>$('otherPermitDialog').close();
    $('violationStatsButton').onclick=()=>{updateViolationStats();$('violationStatsDialog').showModal();};
    $('closeViolationStats').onclick=()=>$('violationStatsDialog').close();
    $('statsExcludeLarge').onchange=()=>{$('includeLargeOverCapacity').checked=!$('statsExcludeLarge').checked;update();};
    $('statsExcludeMultiple').onchange=()=>{$('excludeMultipleOverCapacity').checked=$('statsExcludeMultiple').checked;update();};
    $('showOverOccupancy').onclick=()=>showStatsOnMap('occupancy');
    $('showLikelyUnlicensed').onclick=()=>showStatsOnMap('likely');
    $('revenueLikelyStats').onclick=()=>{$('revenueDialog').close();updateViolationStats();$('violationStatsDialog').showModal();};
    $('potentialRevenueButton').onclick=()=>$('revenueDialog').showModal();$('closeRevenueDialog').onclick=()=>$('revenueDialog').close();
    $('sourcesButton').onclick=()=>$('sourcesDialog').showModal();$('closeSourcesDialog').onclick=()=>$('sourcesDialog').close();
    $('aboutButton').onclick=()=>$('aboutPageDialog').showModal();$('closeAboutPageDialog').onclick=()=>$('aboutPageDialog').close();
    $('legislativeTipsButton').onclick=()=>$('legislativeTipsDialog').showModal();$('closeLegislativeTipsDialog').onclick=()=>$('legislativeTipsDialog').close();
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
