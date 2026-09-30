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
  function overlap(listing, leewayPercent) {
    const radius = effectiveRadius(listing, leewayPercent);
    return radius === null || !finite(listing.nearest_licensed_parcel_m) ? null
      : listing.nearest_licensed_parcel_m <= radius + 1e-6;
  }
  function likelyUnlicensed(listing, leewayPercent, edgeBuffer) {
    return inScope(listing, edgeBuffer) && overlap(listing, leewayPercent) === false;
  }
  function balanceCells(listings, permits, cellFeatures, edgeBuffer) {
    const counts = new Map();
    const cell = id => {if (!counts.has(id)) counts.set(id, {listings:0, permits:0});return counts.get(id);};
    const ids = new Set();
    for (const l of listings) if (l.point && l.cell_id && inScope(l, edgeBuffer) && !ids.has(l.listing_id)) {
      ids.add(l.listing_id);cell(l.cell_id).listings++;
    }
    const permitIds = new Set();
    for (const p of permits) if (p.status === 'current' && p.point && p.cell_id && inScope(p, edgeBuffer) && !permitIds.has(p.id)) {
      permitIds.add(p.id);cell(p.cell_id).permits++;
    }
    return cellFeatures.filter(f => counts.has(f.properties.cell_id)).map(f => {
      const c = counts.get(f.properties.cell_id);
      return {...f, properties:{...f.properties, ...c, difference:c.listings-c.permits}};
    });
  }
  return {effectiveRadius, inScope, overlap, likelyUnlicensed, balanceCells};
})();
