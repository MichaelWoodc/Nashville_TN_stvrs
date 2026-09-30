'use strict';
// Occupancy screening uses the builder's estimates, including its two-license caveat.
const ViolationStats = (() => {
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  function licenseCount(listing) {
    return Math.max(Number(listing.detected_permit_count)||0,
      new Set((listing.permit_numbers||[]).map(String)).size);
  }
  function eligible(listing, excludeLarge=true, excludeMultiple=true) {
    return !listing.likely_hotel && (!excludeLarge || !(listing.bedrooms > 5))
      && (!excludeMultiple || licenseCount(listing) <= 1);
  }
  function overOccupancy(listing, excludeLarge=true, excludeMultiple=true) {
    return eligible(listing,excludeLarge,excludeMultiple) && finite(listing.over_capacity) && listing.over_capacity >= 1;
  }
  function summarize(listings, excludeLarge=true, excludeMultiple=true) {
    const unique=[...new Map(listings.map(l=>[l.listing_id,l])).values()];
    const hotels=unique.filter(l=>l.likely_hotel).length;
    const nonHotels=unique.filter(l=>!l.likely_hotel);
    const large=nonHotels.filter(l=>excludeLarge && l.bedrooms>5).length;
    const afterLarge=nonHotels.filter(l=>!excludeLarge || !(l.bedrooms>5));
    const multiple=afterLarge.filter(l=>excludeMultiple && licenseCount(l)>1).length;
    const candidates=afterLarge.filter(l=>!excludeMultiple || licenseCount(l)<=1);
    const known=candidates.filter(l=>finite(l.over_capacity));
    const over=known.filter(l=>overOccupancy(l,excludeLarge,excludeMultiple)).length;
    return {total:unique.length,hotels,large,multiple,unknown:candidates.length-known.length,
      eligible:known.length,over,percent:known.length?100*over/known.length:null};
  }
  return {licenseCount,eligible,overOccupancy,summarize};
})();
