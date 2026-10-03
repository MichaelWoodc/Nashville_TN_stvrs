'use strict';
const BrowserState=(()=>{
  const stateKey='stvr-map-state-v1',choiceKey='stvr-cookie-choice';let choice='',timer,pendingUI=null,restoring=false;
  const controls=()=>[...document.querySelectorAll('#filters input,#filters select,#hostSearch,#themeToggle')];
  const key=el=>el.id||`${el.type}:${el.className}:${el.value}`;
  const accepted=()=>choice==='accepted';
  function clear(){try{localStorage.removeItem(stateKey);}catch{}clearTimeout(timer);}
  function save(){
    if(pendingUI||restoring||!accepted()||typeof map==='undefined'||!map)return;
    try{localStorage.setItem(stateKey,JSON.stringify({version:1,controls:controls().map(el=>({key:key(el),value:el.value,checked:el.checked})),host:selectedHost,metric:selectedHostMetric,combo:selectedPartyCombo,capacity:selectedPartyRequireCapacity,ui:{filtersCollapsed:document.getElementById('filters').classList.contains('collapsed'),menus:[...document.querySelectorAll('#filters details,.hosts details')].map(e=>e.open),card:activeCardState,pinned:matchPinned,context:matchContext,cardMenus:[...document.querySelectorAll('.maplibregl-popup details')].filter(e=>e.open).map(e=>e.querySelector('summary')?.textContent)},view:{center:map.getCenter().toArray(),zoom:map.getZoom(),bearing:map.getBearing(),pitch:map.getPitch()}}));}catch{}
  }
  function schedule(){if(accepted()){clearTimeout(timer);timer=setTimeout(save,350);}}
  function restore(){
    if(!accepted())return {};
    try{
      const state=JSON.parse(localStorage.getItem(stateKey)||'null');if(state?.version!==1)return {};
      pendingUI=state.ui||null;
      const saved=new Map((state.controls||[]).map(c=>[c.key,c]));
      for(const el of controls()){const value=saved.get(key(el));if(!value||el.disabled)continue;if(el.type==='checkbox')el.checked=Boolean(value.checked);else if(el.tagName!=='SELECT'||[...el.options].some(o=>o.value===value.value))el.value=value.value;}
      selectedHost=listings.some(l=>hostKey(l)===state.host)?state.host:'';selectedHostMetric=state.metric||'';selectedPartyCombo=state.combo||'';selectedPartyRequireCapacity=Boolean(state.capacity);
      document.body.classList.toggle('dark-mode',document.getElementById('themeToggle').checked);
      const v=state.view;if(Array.isArray(v?.center)&&v.center.length===2&&v.center.every(Number.isFinite)&&Math.abs(v.center[0])<=180&&Math.abs(v.center[1])<=90&&Number.isFinite(v.zoom)&&v.zoom>=0&&v.zoom<=22)return v;
    }catch{}return {};
  }
  async function restoreUI(){
    const ui=pendingUI;pendingUI=null;if(!accepted()||!ui)return;restoring=true;
    try{
      if(ui.card?.type==='listing'){const l=listings.find(l=>l.listing_id===ui.card.listing_id);if(l)showListing(l);}
      else if(ui.card?.type==='property'&&ui.card.position)await showProperty(ui.card.property,ui.card.position);
      if(ui.pinned&&ui.context){const l=listings.find(l=>l.listing_id===ui.context.listing_id);if(l){const rows=await Reporting.loadCandidates(l);for(const r of rows)r.type=(l.preliminary_matches||[]).find(m=>normalizeParcel(m.parcel)===normalizeParcel(r.parcel))?.type||'distance';const row=rows.find(r=>normalizeParcel(r.parcel)===normalizeParcel(ui.context.parcel));if(row){pinCandidate(l,row,false);colorNameMatches(l,rows);}}}
      document.getElementById('filters').classList.toggle('collapsed',Boolean(ui.filtersCollapsed));document.getElementById('toggleFilters').textContent=ui.filtersCollapsed?'Show':'Hide';document.getElementById('toggleFilters').setAttribute('aria-expanded',String(!ui.filtersCollapsed));
      [...document.querySelectorAll('#filters details,.hosts details')].forEach((e,i)=>{if(ui.menus?.[i]!==undefined)e.open=ui.menus[i];});
      document.querySelectorAll('.maplibregl-popup details').forEach(e=>e.open=ui.cardMenus?.includes(e.querySelector('summary')?.textContent)||false);
    }finally{restoring=false;schedule();}
  }
  function decide(value){
    choice=value;
    try{localStorage.setItem(choiceKey,value);}catch{}
    document.cookie=`stvr_functional_consent=${value==='accepted'?'accepted':''}; Path=/; SameSite=Lax; Max-Age=${value==='accepted'?31536000:0}${location.protocol==='https:'?'; Secure':''}`;
    if(!accepted()){clear();try{localStorage.removeItem('stvr-doorman-theme');localStorage.removeItem('stvr-doorman-disclaimer-dismissed');}catch{}}else save();
    document.getElementById('cookiePrompt').hidden=true;
  }
  function setup(){
    try{choice=document.cookie.split('; ').find(c=>c.startsWith('stvr_functional_consent='))?.split('=')[1]||localStorage.getItem(choiceKey)||'';}catch{}
    if(!accepted()){clear();try{localStorage.removeItem('stvr-doorman-theme');localStorage.removeItem('stvr-doorman-disclaimer-dismissed');}catch{}}
    const prompt=document.getElementById('cookiePrompt');prompt.hidden=choice==='accepted'||choice==='denied';
    document.getElementById('acceptCookies').onclick=()=>decide('accepted');document.getElementById('denyCookies').onclick=()=>decide('denied');document.getElementById('cookieSettings').onclick=()=>{prompt.hidden=false;};
    for(const event of ['input','change','click'])document.addEventListener(event,e=>{if(!e.target.closest('#cookiePrompt'))schedule();});
    document.addEventListener('toggle',e=>{if(e.target.matches('#filters details,.hosts details,.maplibregl-popup details'))schedule();},true);
    window.addEventListener('pagehide',save);
  }
  return {setup,accepted,restore,restoreUI,schedule,save,clear};
})();
