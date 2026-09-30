let newLocationPlacementMode = false;

function enableLocationSelectionAddresses() {
  const checkbox = document.getElementById('parcelAddressesCheckbox');
  if (!checkbox) return;
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event('change', { bubbles: true }));
}


const normalizeExactParcelAddress = value => String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
const submissionAddressFileCache = new Map();
function readSubmissionAddressFile(path) {
  if (!submissionAddressFileCache.has(path)) {
    const pending = fetch('data/geography_files/parcel_address_tiles/' + path)
      .then(response => {
        if (!response.ok) throw new Error('Address data could not be loaded');
        return response.json();
      }).catch(error => { submissionAddressFileCache.delete(path); throw error; });
    submissionAddressFileCache.set(path, pending);
  }
  return submissionAddressFileCache.get(path);
}
async function findSubmissionAddressOptions(prefix) {
  if (!prefix) return [];
  const manifest = await readSubmissionAddressFile('address_search/options_manifest.json');
  const filename = manifest[prefix[0]];
  if (!filename) return [];
  const addresses = await readSubmissionAddressFile('address_search/' + filename);
  return addresses.filter(address => address.startsWith(prefix));
}
async function findKnownSubmissionAddresses(key) {
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.codePointAt(0)) % 256;
  const shard = await readSubmissionAddressFile(`address_search/${hash.toString(16).padStart(2, '0')}.json`);
  const filenames = Object.prototype.hasOwnProperty.call(shard, key) ? shard[key] : [];
  const matches = new Map();
  for (const filename of filenames) {
    const records = await readSubmissionAddressFile(filename);
    for (const [lng, lat, address] of records) {
      if (![normalizeExactParcelAddress(address), normalizeExactParcelAddress(address.split(',')[0])].includes(key)) continue;
      if (Number.isFinite(lng) && Number.isFinite(lat)) matches.set(`${lng},${lat}`, {lng, lat, address});
    }
  }
  return [...matches.values()];
}

function initializeCountySubmission(map, { loadAddresses, nearestAddress, closeExisting }) {
  const menu = document.getElementById('countyMenu');
  const panel = document.getElementById('newLocationPanel');
  const address = document.getElementById('newLocationAddress');
  const status = document.getElementById('newLocationStatus');
  const coordinates = document.getElementById('newLocationCoordinates');
  const proceed = document.getElementById('newLocationContinue');
  const typedAddress = document.getElementById('newLocationSearchAddress');
  const addressOptions = document.getElementById('newLocationAddressOptions');
  const optionCount = document.getElementById('newLocationAddressOptionCount');
  function clearAddressOptions() { addressOptions.replaceChildren(); addressOptions.hidden = true; optionCount.textContent = ''; }
  let marker = null;
  let selected = null;
  let request = 0;
  let addressSearchTimer = null;

  function cancel() {
    ++request;
    newLocationPlacementMode = false;
    if (marker) marker.remove();
    marker = null;
    selected = null;
    panel.hidden = true;
    clearAddressOptions();
    clearTimeout(addressSearchTimer);
    document.body.classList.remove('placing-new-location');
    map.getCanvas().style.cursor = '';
  }

  async function updateLocation(point) {
    const currentRequest = ++request;
    selected = { lng: point.lng, lat: point.lat };
    coordinates.textContent = `Latitude: ${point.lat.toFixed(6)}, Longitude: ${point.lng.toFixed(6)}`;
    address.value = '';
    address.disabled = true;
    proceed.disabled = true;
    status.textContent = 'Looking up a nearby parcel address...';
    try {
      const records = await loadAddresses(point.lng, point.lat);
      if (currentRequest !== request) return;
      address.value = nearestAddress(records, point.lng, point.lat) || '';
      status.textContent = address.value
        ? 'Check the suggested nearby address. Drag the pin or click the map to adjust the location.'
        : 'No parcel address found. Enter the address, or complete it in the form. Drag the pin to adjust.';
    } catch (error) {
      if (currentRequest !== request) return;
      status.textContent = 'Address lookup is unavailable. Enter the address, or complete it in the form.';
    } finally {
      if (currentRequest === request) {
        address.disabled = false;
        proceed.disabled = false;
      }
    }
  }

  document.getElementById('newLocationButton').addEventListener('click', () => {
    cancel();
    closeExisting();
    menu.open = false;
    newLocationPlacementMode = true;
    enableLocationSelectionAddresses();
    document.body.classList.add('placing-new-location');
    panel.hidden = false;
    address.value = '';
    typedAddress.value = '';
    address.disabled = true;
    proceed.disabled = true;
    coordinates.textContent = '';
    status.textContent = 'Click or tap the map to drop a pin, then drag it to adjust the location.';
  });
  document.getElementById('newLocationCancel').addEventListener('click', cancel);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { menu.open = false; cancel(); }
  });
  document.addEventListener('click', event => {
    if (!menu.contains(event.target)) menu.open = false;
  });
  function placeMarker(point) {
    if (!marker) {
      marker = new maplibregl.Marker({ color: '#dc2626', draggable: true }).setLngLat(point).addTo(map);
      marker.on('dragstart', () => { ++request; proceed.disabled = true; clearTimeout(addressSearchTimer); });
      marker.on('dragend', () => updateLocation(marker.getLngLat()));
    } else marker.setLngLat(point);
  }
  map.on('click', event => {
    if (!newLocationPlacementMode) return;
    clearTimeout(addressSearchTimer);
    placeMarker(event.lngLat);
    updateLocation(event.lngLat);
  });
  addressOptions.addEventListener('change', () => {
    typedAddress.value = addressOptions.value;
    clearTimeout(addressSearchTimer);
    searchTypedAddress();
  });
  typedAddress.addEventListener('input', () => {
    clearAddressOptions();
    ++request;
    selected = null;
    if (marker) marker.remove();
    marker = null;
    proceed.disabled = true;
    clearTimeout(addressSearchTimer);
    address.value = '';
    coordinates.textContent = '';
    status.textContent = typedAddress.value.trim() ? 'Searching for an exact known address as you type...' : 'Click or tap the map to drop a pin, then drag it to adjust the location.';
    if (typedAddress.value.trim()) addressSearchTimer = setTimeout(searchTypedAddress, 300);
  });
  typedAddress.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); clearTimeout(addressSearchTimer); searchTypedAddress(); }
  });
  async function searchTypedAddress() {
    if (!newLocationPlacementMode) return;
    const key = normalizeExactParcelAddress(typedAddress.value);
    const currentRequest = ++request;
    selected = null;
    if (marker) marker.remove();
    marker = null;
    proceed.disabled = true;
    address.value = '';
    coordinates.textContent = '';
    if (!key) { status.textContent = 'Enter the complete street address.'; return; }
    status.textContent = 'Checking known geography addresses...';
    try {
      const options = await findSubmissionAddressOptions(key);
      if (currentRequest !== request) return;
      const fragment = document.createDocumentFragment();
      options.forEach(value => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        fragment.appendChild(option);
      });
      addressOptions.replaceChildren(fragment);
      addressOptions.selectedIndex = -1;
      addressOptions.hidden = options.length === 0;
      optionCount.textContent = `${options.length} matching address${options.length === 1 ? '' : 'es'}`;
      const matches = await findKnownSubmissionAddresses(key);
      if (currentRequest !== request) return;
      if (matches.length !== 1) {
        status.textContent = matches.length ? 'This exact address has multiple parcel locations. Please place the pin on the map.' : (options.length ? 'Keep typing to narrow the list, or select a known address below.' : 'No known address starts with this text. Check the address or place a pin on the map.');
        return;
      }
      const match = matches[0];
      selected = {lng: match.lng, lat: match.lat};
      placeMarker(selected);
      address.value = match.address;
      address.disabled = true;
      coordinates.textContent = `Latitude: ${match.lat.toFixed(6)}, Longitude: ${match.lng.toFixed(6)}`;
      status.textContent = 'Exact known address found. Check the parcel pin, then continue or drag it to adjust.';
      proceed.disabled = false;
      map.flyTo({center: [match.lng, match.lat], zoom: Math.max(map.getZoom(), 16)});
    } catch {
      if (currentRequest === request) status.textContent = 'The full address list could not be loaded. Try again or place a pin on the map.';
    }
  }
  proceed.addEventListener('click', () => {
    if (!selected || proceed.disabled) return;
    const url = ListingLocations.reportUrl({address: address.value, longitude: selected.lng, latitude: selected.lat});
    window.open(url, '_blank', 'noopener');
  });
}
