'use strict';
const Reporting = (() => {
  const tileCache=new Map(), bucketCache=new Map();
  let manifestPromise, configPromise, renderToken=0, dialogToken=0, activeListing, activeRows=[], selected=null;
  const node=id=>document.getElementById(id);
  const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const json=async path=>{const response=await fetch(path,{cache:'no-store'});if(!response.ok)throw Error(`${path}: ${response.status}`);return response.json();};
  function manifest(){return manifestPromise ||= json('data/nearby_parcels/manifest.json').catch(e=>{manifestPromise=null;throw e;});}
  function tile(name){if(!tileCache.has(name))tileCache.set(name,json(`data/nearby_parcels/${name}`).catch(e=>{tileCache.delete(name);throw e;}));return tileCache.get(name);}
  function invalidate(){manifestPromise=null;bucketCache.clear();tileCache.clear();}
  async function loadCandidates(listing) {
    const key=listing.listing_id.slice(-2);
    if(!bucketCache.has(key))bucketCache.set(key,json(`data/nearby_candidates/${key}.json`).catch(e=>{bucketCache.delete(key);throw e;}));
    const bucket=await bucketCache.get(key), refs=bucket[listing.listing_id]||[];
    const data=await Promise.all([...new Set(refs.map(c=>c.tile))].map(tile));
    const properties=new Map(data.flatMap(d=>d.features.map(f=>[String(f.properties.id),f.properties])));
    return refs.map(c=>({...properties.get(c.id),distance_m:c.distance_m})).filter(c=>c.address&&c.distance_m<=550).sort((a,b)=>a.distance_m-b.distance_m||a.address.localeCompare(b.address));
  }
  async function loadViewport(map) {
    const token=++renderToken;
    if(!map.getSource('nearby-parcels'))return;
    if(map.getZoom()<15){map.getSource('nearby-parcels').setData({type:'FeatureCollection',features:[]});return;}
    try {
      const m=await manifest(), b=map.getBounds();
      const names=m.tiles.filter(t=>t.bounds[0]<=b.getEast()&&t.bounds[2]>=b.getWest()&&t.bounds[1]<=b.getNorth()&&t.bounds[3]>=b.getSouth()).map(t=>t.file);
      const data=await Promise.all(names.map(tile));
      if(token===renderToken)map.getSource('nearby-parcels').setData({type:'FeatureCollection',features:data.flatMap(d=>d.features)});
    }catch(e){console.error('Nearby parcels:',e);}
  }
  function distance(a,b){const r=Math.PI/180,x=(b[1]-a[1])*r,y=(b[0]-a[0])*r;return 12742017.6*Math.asin(Math.min(1,Math.sqrt(Math.sin(x/2)**2+Math.cos(a[1]*r)*Math.cos(b[1]*r)*Math.sin(y/2)**2)));}
  function licenseRows(parcels, listing) {
    const distances=new Map();for(const p of parcels)if(!distances.has(p.parcel)||p.distance_m<distances.get(p.parcel).distance_m)distances.set(p.parcel,p);
    return window.nashville.permits.map(p=>{
      const parcel=distances.get(p.parcel), d=parcel?.distance_m ?? (p.point?distance(listing.point,p.point):Infinity);
      return {...p,id:`permit:${p.id}`,permit_id:p.id,owner:p.owner||parcel?.owner||'',parcel_owner:parcel?.owner||'',distance_m:d,distance_basis:parcel?'parcel boundary':'permit point',point:p.point||parcel?.point,
        license:p.permit_number||`Nashville permit record ObjectId ${p.id}: ${p.address} (${p.source_status}; permit number unavailable)`};
    }).filter(p=>p.distance_m<=550).sort((a,b)=>a.distance_m-b.distance_m||a.address.localeCompare(b.address));
  }
  function prefilledUrl(config, values) {
    const url=new URL(config.form_url);
    if(url.protocol!=='https:'||url.hostname!=='docs.google.com'||!url.pathname.startsWith('/forms/'))throw Error('Expected an HTTPS Google Forms URL');
    url.searchParams.set('usp','pp_url');
    for(const [key,entry] of Object.entries(config.fields||{}))if(/^entry\.\d+$/.test(entry))url.searchParams.set(entry,String(values[key]??''));
    return url.toString();
  }
  function select(row) {
    selected=row;
    node('reportSelection').textContent=`Selected: ${row.address} · Owner: ${row.owner||'Unavailable'} · ${row.distance_m.toFixed(1)} m from the Airbnb point to the ${row.distance_basis||'parcel boundary'}`;
    node('continueReport').disabled=false;
    renderRows();
  }
  function renderRows() {
    const query=node('reportSearch').value.toLowerCase().trim();
    const rows=activeRows.filter(r=>[r.address,r.owner,r.parcel,r.permit_number,r.permit_id].join(' ').toLowerCase().includes(query));
    node('reportCount').textContent=`${rows.length.toLocaleString()} candidates within 550 m · nearest first`;
    const container=node('reportCandidates');container.replaceChildren();
    for(const row of rows){
      const button=document.createElement('button');button.type='button';button.className='report-candidate'+(selected?.id===row.id?' selected':'');
      button.innerHTML=`<strong>${escape(row.address)}</strong><span>${row.distance_m.toFixed(1)} m · Parcel ${escape(row.parcel)}</span><span>Owner: ${escape(row.owner||'Unavailable')}</span>${row.permit_id?`<span>Permit ${escape(row.permit_number||'number unavailable')} · ${escape(row.source_status)} · Record ${escape(row.permit_id)}</span>`:''}`;
      button.onclick=()=>select(row);container.append(button);
    }
    if(!rows.length)container.textContent='No matching candidates within 550 m. Try a different address or owner search.';
  }
  async function open(listing, type='address') {
    const token=++dialogToken;activeListing=listing;selected=null;activeRows=[];
    node('reportType').value=type;node('reportSearch').value='';node('reportSelection').textContent='Select an address or permit below.';node('continueReport').disabled=true;
    node('reportListing').textContent=listing.title||listing.listing_id;node('reportCandidates').textContent='Loading nearby addresses and owners…';node('reportCount').textContent='';
    if(!node('reportDialog').open)node('reportDialog').showModal();
    try {
      const parcels=await loadCandidates(listing);
      if(token!==dialogToken)return;
      activeRows=type==='license'?licenseRows(parcels,listing):parcels;
      renderRows();
    }catch(e){node('reportCandidates').textContent=`Could not load nearby parcels: ${e.message}`;}
  }
  function setup() {
    node('closeReport').onclick=()=>node('reportDialog').close();
    node('reportSearch').oninput=renderRows;
    node('reportType').onchange=()=>open(activeListing,node('reportType').value);
    // Normal link navigation only: no Google Form is submitted by this site.
    node('continueReport').onclick=async()=>{
      if(!selected)return;
      try {
        configPromise ||= json('reporting_config.json');
        const config=await configPromise;
        const values={listing_url:activeListing.url,address:selected.address,longitude:selected.point?.[0]??'',latitude:selected.point?.[1]??'',license:node('reportType').value==='license'?selected.license:''};
        const url=prefilledUrl(config,values);
        window.open(url,'_blank','noopener,noreferrer');
      }catch(e){node('reportSelection').textContent=`Could not open form: ${e.message}`;}
    };
    // Warm only the tiny form configuration, not parcel geometry.
    configPromise=json('reporting_config.json').catch(e=>{configPromise=null;console.error(e);});
  }
  return {open,setup,loadCandidates,loadViewport,invalidate,prefilledUrl,licenseRows};
})();
