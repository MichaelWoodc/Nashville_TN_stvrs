'use strict';
// Pure spatial screening functions. Distances/cells are generated in metric EPSG:26916.
const Spatial = (() => {
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  function effectiveRadius(listing, leewayPercent) {
    return finite(listing.privacy_radius_meters) && listing.privacy_radius_meters >= 0
      ? listing.privacy_radius_meters * (1 + leewayPercent / 100) : null;
  }
  function inScope(record, edgeBuffer) {
    return finite(record.boundary_distance_m) && record.boundary_distance_m >= -edgeBuffer;
  }
  function overlap(listing, leewayPercent, parcelToleranceMeters=0) {
    const radius = effectiveRadius(listing, leewayPercent);
    return radius === null || !finite(listing.nearest_licensed_parcel_m) ? null
      : listing.nearest_licensed_parcel_m <= radius + parcelToleranceMeters + 1e-6;
  }
  function likelyUnlicensed(listing, leewayPercent, edgeBuffer, parcelToleranceMeters=0) {
    return inScope(listing, edgeBuffer) && overlap(listing, leewayPercent, parcelToleranceMeters) === false;
  }
  function balanceCells(listings, permits, cellFeatures, edgeBuffer, radius=0) {
    const counts = new Map();
    const cell = id => {if (!counts.has(id)) counts.set(id, {listings:0, permits:0});return counts.get(id);};
    const ids = new Set();
    for (const l of listings) if (l.point && l.cell_id && inScope(l, edgeBuffer) && !ids.has(l.listing_id)) {
      ids.add(l.listing_id);cell(l.cell_id).listings++;
    }
    const permitIds = new Set();
    for (const p of permits) if (p.status === 'current' && p.point && p.cell_id && inScope(p, edgeBuffer) && !permitIds.has(p.id)) {
      const parcelId=String(p.parcel||p.id);
      if(permitIds.has(parcelId))continue;
      permitIds.add(parcelId);cell(p.cell_id).permits++;
    }
    const populated = new Map([...counts].filter(([,value])=>value.listings||value.permits));
    const reach = Math.max(0, Number(radius)||0);
    return cellFeatures.map(f => {
      const [cellX,cellY]=f.properties.cell_id.split('_').map(Number);
      const range=Math.ceil(reach/500), local={listings:0,permits:0};
      for(let dx=-range;dx<=range;dx++)for(let dy=-range;dy<=range;dy++){
        if(Math.hypot(dx*500,dy*500)>reach)continue;
        const neighbor=populated.get(`${cellX+dx}_${cellY+dy}`);
        if(neighbor){local.listings+=neighbor.listings;local.permits+=neighbor.permits;}
      }
      return local.listings||local.permits?{...f, properties:{...f.properties, ...local, difference:local.listings-local.permits}}:null;
    }).filter(Boolean);
  }
  return {effectiveRadius, inScope, overlap, likelyUnlicensed, balanceCells};
})();
