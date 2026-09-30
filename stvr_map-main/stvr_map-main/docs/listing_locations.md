# Listing locations

Run from the project directory:

```powershell
python scripts/migrate_listing_locations.py
python scripts/migrate_listing_locations.py --check
```

The migration covers all eight listing JS datasets, including archive and backup copies. You can supply specific file paths instead. It preserves listing counts, license metadata, other listing fields, and JavaScript after the data array. Conflicting old/new fields stop migration with an error. Repeated runs preserve confirmed locations.

Persisted fields:

- `airbnb_approximate_address`: former `approximate_address`.
- `airbnb_latitude` / `airbnb_longitude`: former listing `latitude` / `longitude`.
- `actual_address` / `actual_latitude` / `actual_longitude`: confirmed location, initially `null`.

When you confirm a location, fill in all three `actual_*` fields on that listing. Coordinates use decimal degrees, with longitude negative in Chatham County. Update the same listing in `locations.js`, `unincorporated_locations.js`, and `unincorporated_locations_matched_hosts.js` as applicable so the live maps agree. Do not substitute license coordinates unless you have independently confirmed that they locate the listing. Existing `address` fields are retained as legacy metadata and are not treated as confirmed addresses.

Blue circles show the approximate location for listings with an actual location; green circles show the actual location. A dashed line joins them. Either opens the listing's existing card, which includes both address fields. Missing, blank, or invalid actual coordinates do not generate a second marker. Paired markers follow listing filters and are separate from clustering so they do not inflate listing totals. At identical coordinates, a larger blue circle surrounds the green circle.

County maps retain existing license-match rules and draw connections from both listing locations to the matched license. An actual location does not create a license match. The runtime helper supplies legacy coordinate aliases only in browser memory for existing map calculations; the datasets use the explicit field names.

If a notebook or older exporter regenerates legacy fields, rerun the migration before opening the maps. The host-matching script reads the renamed approximate coordinates directly.
