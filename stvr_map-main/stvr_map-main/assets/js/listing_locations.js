/* Persisted listing fields are explicit; aliases below are only for existing map calculations. */
const ListingLocations = (() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
  function actual(loc) {
    const lat = loc.actual_latitude, lng = loc.actual_longitude;
    if (lat == null || lng == null || String(lat).trim() === '' || String(lng).trim() === '') return null;
    const point = [Number(lng), Number(lat)];
    return point.every(Number.isFinite) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90 ? point : null;
  }
  function reportUrl({listingUrl = '', address = '', longitude = null, latitude = null, licenseNumber = ''} = {}) {
    const url = new URL('https://docs.google.com/forms/d/e/1FAIpQLSf0UzTMk7k2NIsRYuNL54MmFjRmVHlXTXGVMsBnyUZYjNoJzA/viewform');
    url.searchParams.set('usp', 'pp_url');
    url.searchParams.set('entry.1013247072', String(listingUrl || '').trim());
    url.searchParams.set('entry.1545663527', String(address || '').trim());
    const point = actual({actual_longitude: longitude, actual_latitude: latitude});
    if (point) {
      url.searchParams.set('entry.997202982', String(point[0]));
      url.searchParams.set('entry.1827194001', String(point[1]));
    }
    if (licenseNumber) url.searchParams.set('entry.1993836701', licenseNumber);
    return url.toString();
  }
  function listingKey(value) {
    try {
      const url = new URL(String(value || '').trim());
      if (!['https:', 'http:'].includes(url.protocol)) return '';
      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      const airbnbId = /(^|\.)airbnb\.[a-z.]+$/.test(host) && url.pathname.match(/\/rooms\/(\d+)/)?.[1];
      if (airbnbId) return `airbnb:${airbnbId}`;
      return host + url.pathname.replace(/\/+$/, '');
    } catch { return ''; }
  }
  const originalActualLocations = new WeakMap();
  function applySubmittedLocation(item, submissions) {
    if (!originalActualLocations.has(item)) {
      originalActualLocations.set(item, {actual_address: item.actual_address ?? null,
        actual_longitude: item.actual_longitude ?? null, actual_latitude: item.actual_latitude ?? null,
        actual_location_source: item.actual_location_source ?? null});
    }
    Object.assign(item, originalActualLocations.get(item));
    // Keep the address and coordinates from the same response. Blank-coordinate
    // responses retain their metadata without displacing a usable submitted pin.
    const pins = submissions.filter(s => s.coordinateSource === 'submitted_pin');
    const candidates = pins.length ? pins : submissions.filter(s => s.coordinateSource === 'parcel_address_match');
    const latest = candidates.filter(s => actual({actual_longitude: s.addressCoordinates?.[0], actual_latitude: s.addressCoordinates?.[1]}))
      .slice().sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0)).pop();
    if (latest) {
      item.actual_address = latest.address || null;
      [item.actual_longitude, item.actual_latitude] = latest.addressCoordinates;
      item.actual_location_source = latest.coordinateSource === 'submitted_pin' ? 'visitor_submission' : 'visitor_parcel_match';
    }
  }
  function normalize(loc) {
    loc.latitude = loc.airbnb_latitude ?? loc.latitude;
    loc.longitude = loc.airbnb_longitude ?? loc.longitude;
    loc.approximate_address = loc.airbnb_approximate_address ?? loc.approximate_address;
    return loc;
  }
  function details(loc) {
    const actualAddress = String(loc.actual_address || '').trim();
    const approximateAddress = loc.airbnb_approximate_address ?? loc.approximate_address ?? '';
    const addressLabel = actualAddress
      ? (loc.actual_location_source === 'visitor_parcel_match' ? 'Reported address (parcel location, unverified)' : loc.actual_location_source === 'visitor_submission' ? 'Submitted actual address (unverified)' : 'Actual address')
      : 'Airbnb approximate address';
    const address = actualAddress || approximateAddress || 'Not confirmed';
    return `<div class="listing-location-details"><strong>${addressLabel}:</strong> ${escape(address)}${actual(loc) ? '<br/><span style="color:#047857">Listings with licenses on other parcels are connected with a line, the circle with the blue outline is the Airbnb location, the purple outline dot is the suspected address.</span>' : ''}</div>`;
  }
  let visible = [], activeMap = null, lastData = '';
  const collection = features => ({type: 'FeatureCollection', features});
  const parcelCells = new Map();
  const parcelCellKey = point => `${Math.floor(point[0] * 100)},${Math.floor(point[1] * 100)}`;
  function inRing(point, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > point[1]) !== (b[1] > point[1]) &&
          point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }
  function inParcel(point, geometry) {
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    return polygons.some(rings => inRing(point, rings[0]) && !rings.slice(1).some(ring => inRing(point, ring)));
  }
  function addParcels(features) {
    features.forEach(feature => {
      const geometry = feature.geometry;
      if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) return;
      const points = geometry.coordinates.flat(geometry.type === 'Polygon' ? 1 : 2);
      let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
      points.forEach(([x,y]) => {minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);});
      for(let x=Math.floor(minX*100);x<=Math.floor(maxX*100);x++)
        for(let y=Math.floor(minY*100);y<=Math.floor(maxY*100);y++) {
          const key=`${x},${y}`;
          if (!parcelCells.has(key)) parcelCells.set(key, []);
          parcelCells.get(key).push(geometry);
        }
    });
    render();
  }
  function sameParcel(loc) {
    const endpoint = actual(loc);
    if (!endpoint) return false;
    const approximate = [Number(loc.airbnb_longitude ?? loc.longitude), Number(loc.airbnb_latitude ?? loc.latitude)];
    if (approximate.every((n,i) => n === endpoint[i])) return true;
    const normalizeAddress = value => String(value || '').split(',')[0].toUpperCase().replace(/[^A-Z0-9]/g, '');
    const approximateAddress = normalizeAddress(loc.airbnb_approximate_address ?? loc.approximate_address ?? loc.address);
    const actualAddress = normalizeAddress(loc.actual_address);
    if (approximateAddress && actualAddress && approximateAddress === actualAddress) return true;
    return (parcelCells.get(parcelCellKey(approximate)) || [])
      .some(geometry => inParcel(approximate, geometry) && inParcel(endpoint, geometry));
  }
  function featuresFor(data) {
    return data.flatMap(loc => {
      const endpoint = actual(loc);
      if (!endpoint || sameParcel(loc)) return [];
      const approximate = [Number(loc.displayLongitude ?? loc.airbnb_longitude ?? loc.longitude), Number(loc.displayLatitude ?? loc.airbnb_latitude ?? loc.latitude)];
      if (!approximate.every(Number.isFinite)) return [];
      return [
        {type: 'Feature', geometry: {type: 'Point', coordinates: approximate}, properties: {...loc, location_kind: 'approximate'}},
        {type: 'Feature', geometry: {type: 'Point', coordinates: endpoint}, properties: {...loc, location_kind: 'actual'}},
        {type: 'Feature', geometry: {type: 'LineString', coordinates: [approximate, endpoint]}, properties: {location_kind: 'connection'}}
      ];
    });
  }
  function render() {
    const source = activeMap?.getSource('actual-listing-locations');
    if (!source) return;
    const data = collection(featuresFor(visible));
    const serialized = JSON.stringify(data);
    if (serialized !== lastData) { lastData = serialized; source.setData(data); }
  }
  function setVisible(data) { visible = data; render(); }
  function onListingClick(map, layer, callback) {
    if (!map.getSource('actual-listing-locations')) {
      activeMap = map;
      map.addSource('actual-listing-locations', {type:'geojson', data: collection([])});
      map.addLayer({id:'actual-listing-lines', type:'line', source:'actual-listing-locations', minzoom:14, filter:['==', ['geometry-type'], 'LineString'], paint:{'line-color':'#047857', 'line-width':2, 'line-dasharray':[3,2]}});
      const baseCircle = map.getStyle().layers.find(item => item.id === layer);
      const baseLabel = map.getStyle().layers.find(item => item.id === 'strv-labels');
      map.setPaintProperty(layer, 'circle-stroke-color', '#2563eb');
      if (map.getLayer('spiderfy-circles')) map.setPaintProperty('spiderfy-circles', 'circle-stroke-color', '#2563eb');
      map.addLayer({id:'actual-listing-points', type:'circle', source:'actual-listing-locations', minzoom:14, filter:['all', ['==', ['geometry-type'], 'Point'], ['!', ['get', 'isFullyVerifiedParcel']]],
        paint:{...baseCircle.paint, 'circle-stroke-color':['match', ['get','location_kind'], 'actual', '#9333ea', '#2563eb'], 'circle-stroke-width':3}});
      if (baseLabel) map.addLayer({id:'actual-listing-labels', type:'symbol', source:'actual-listing-locations', minzoom:14, filter:['==', ['geometry-type'], 'Point'],
        layout:{...baseLabel.layout, 'text-allow-overlap':true, 'text-ignore-placement':true}, paint:{...baseLabel.paint}});
      map.on('click', 'actual-listing-points', callback);
      map.on('mouseenter', 'actual-listing-points', () => {map.getCanvas().style.cursor = 'pointer';});
      map.on('mouseleave', 'actual-listing-points', () => {map.getCanvas().style.cursor = '';});
      render();
    }
    map.on('click', layer, event => {
      if (map.queryRenderedFeatures(event.point, {layers:['actual-listing-points']}).length) return;
      callback(event);
    });
  }
  function licenseConnections(features, listings) {
    const byUrl = new Map(listings.map(loc => [loc.url, loc]));
    const byPoint = new Map();
    listings.forEach(loc => {
      if (!actual(loc)) return;
      byPoint.set(JSON.stringify([Number(loc.longitude), Number(loc.latitude)]), loc);
      byPoint.set(JSON.stringify([Number(loc.displayLongitude ?? loc.longitude), Number(loc.displayLatitude ?? loc.latitude)]), loc);
    });
    return features.flatMap(feature => {
      const loc = feature.properties.listingUrl ? byUrl.get(feature.properties.listingUrl) : byPoint.get(JSON.stringify(feature.geometry.coordinates[0]));
      return loc && actual(loc) && !sameParcel(loc) ? [feature, {...feature, geometry:{type:'LineString', coordinates:[actual(loc), feature.geometry.coordinates[1]]}}] : [feature];
    });
  }
  function leafletPair(loc, marker, group) {
    const point = actual(loc);
    if (!point) return;
    marker.setStyle?.({fillColor:'#2563eb'});
    const pin = marker.getElement?.()?.querySelector('.map-pin');
    if (pin) pin.style.backgroundColor = '#2563eb';
    const html = marker.getPopup().getContent();
    L.polyline([[loc.latitude, loc.longitude], [point[1], point[0]]], {color:'#047857', dashArray:'6 4'}).addTo(group);
    L.circleMarker([point[1], point[0]], {radius:9, color:'#fff', fillColor:'#047857', fillOpacity:1}).bindPopup(html).addTo(group);
  }
  return {sameParcel, addParcels, listingKey, applySubmittedLocation, reportUrl, actual, normalize, details, setVisible, onListingClick, licenseConnections, leafletPair, featuresFor};
})();
if (typeof locations !== 'undefined') locations.forEach(ListingLocations.normalize);
