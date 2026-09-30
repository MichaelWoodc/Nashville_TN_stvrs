# Nashville STR map

Builds `nashville_site/`, a static site using the Chatham example's map workflow:
listing circles, host/search filters, privacy and permit coverage rings, green
licensed parcels, parcel address labels, a heatmap, and listing/permit popups.
The original Chatham site and all input files are preserved. Nashville's output
has no Chatham complaint forms, county fee estimates, or Hochatown message.

## Run

Python 3.10 or newer, plus Shapely 2 and pyproj for metric spatial analysis (`pip install -r requirements.txt`). These are installed in the configured Anaconda environment.

```powershell
# Build once (run from this project folder)
& C:\Users\micha\anaconda3\python.exe build_nashville.py

# Incremental scanner, rebuild, and local preview; Ctrl+C stops it
& C:\Users\micha\anaconda3\python.exe -u build_nashville.py --watch --serve 8765
```

Open http://127.0.0.1:8765. The background instance started during setup writes
`.nashville_cache/watcher.log`, `watcher.error.log`, and `watcher.pid`.
The map footer reports its heartbeat and offers **Load updated data** after a
rebuild. To stop that instance gracefully:

```powershell
New-Item .nashville_cache/STOP -ItemType File -Force
```

Remove that exact STOP file before restarting. `start_nashville.ps1` starts a
background watcher with logs; it detects an existing matching process.
It does not auto-start with Windows. Keep the computer awake for scanning.

## Inputs and refresh

- `listing_urls.csv`: all known URLs. Full listing IDs come from the URL,
  preserving IDs that may have been rounded in spreadsheets.
- `listing_details.csv`: baseline data, including locations for listings whose
  detailed scrape has not arrived yet.
- `listing_results/<listing_id>/metadata.json` and `details.txt`: saved listing
  text, capacity, host and radius information. New or changed files are checked
  every 30 seconds. Only changed text files are rescanned; matching is rebuilt
  against the current permit snapshot. This reads saved text, not live Airbnb
  pages, PDFs, or photos. Missing/partial files are tolerated and reported.
- `nashville_permits/nashville_permits.csv`: all supplied permit statuses.
- `Parcels*.geojson`: Nashville parcel polygons. Parcel IDs stay strings; parcel
  joins use the permit's Parcel and geometry's STANPAR fields.
- `website_template/`: edit the site here, then rebuild. Changes are detected by
  the watcher. Changes to Python itself require restarting the watcher.

The scanner caches metadata and evidence under `.nashville_cache/`. Source files
are never rewritten. Blank metadata never deletes a known value. Repair output
is `nashville_site/data/listing_details_repaired.csv`, with a field-level
`repair_audit.csv`. Enrichment includes description and metadata fields, not only
capacity corrections. Capacity is filled from structured saved fields or a
strict guest/bedroom header, not guessed from marketing text or bed counts.

## Occupancy and party filters

Capacity is **min(2 × bedrooms + 4, 12)**. Three bedrooms = 10; six = 12.
Overage = max(0, guests − capacity). Missing bedroom counts remain unknown;
only a known excess above 12 is flagged in that case. Advertised bedrooms may
not equal legally permitted sleeping rooms. Popups explain this limitation.

Pool, hot tub/hottub/jacuzzi, whole-word bar, and pool table produce 🩱, 👙, 🍻,
and 🎱. Karaoke anywhere in listing text adds 🎤. Pool table alone does not also trigger swimming pool. Any category
adds 🥳. Keyword evidence is in the popup; nearby amenities and negative phrases
can match. Selected categories use OR, with a checkbox to require all. Overage
and amenity filters combine. Symbols are optional and placed around markers.
Up to 600 on-screen symbol groups render at once; a visible note asks users to
zoom/filter when that limit is reached. All listing circles remain in the map.

## Permit matching and the source-data issue

The supplied CSV's **Permit # field contains addresses in all 17,592 rows**, not
permit identifiers. The live ArcGIS feed was checked and has the same issue.
The builder will not invent identifiers or infer a direct match from proximity.
Extracted numbers and evidence are still shown in listing cards and exported.

For a corrected future export, put actual identifiers in Permit #. Alternatively
create `permit_number_crosswalk.csv` at the project root:

```csv
object_id,permit_number,source_url
```

Add only authoritative mappings to the ObjectId in the local permit CSV, with
the source URL. Do not use a positional row match across different exports;
ObjectIds can change when a source is republished.

Numbers are normalized from a complete 10-digit number, optional CASR/STR/T
prefix, or an explicit year/serial formatting such as `2015_followed by_17031`.
Evidence records distinguish exact and formatted extraction. A referenced
number still does not prove a listing is at that permit's address.

Every direct number match appears in the card, regardless of status. Expired
matches are yellow, with advertised guests and +overage inside the marker at
close zoom. Above-capacity markers have a red border. A current matched record
takes color precedence when several different statuses match; the card keeps
all of them. Cancelled/revoked/other records remain distinct.

Current permits mean source ISSUED with no expiration date before the build
date. Source and effective statuses are both retained. Missing expiration dates
do not establish that a permit remains legally valid. The green polygons show
parcels containing at least one such record, not verified listing matches or
authorization of every unit on a parcel. Historical permit points are optional.
The two ISSUED records already past expiration are displayed as expired.

## Output and publishing

Upload the contents of `nashville_site/` to a static web host (e.g. a GitHub
Pages folder). Serve via HTTP, not `file://`. The site uses MapLibre, OpenStreetMap
tiles, and hosted font files, so rendering needs an internet connection.
Publish updated generated files after each desired data refresh; local scanner
updates do not automatically publish to a remote host.

Useful files under `nashville_site/data/`:

- `listings.json` / `.csv`: inventory, statuses, capacity, evidence, amenities.
- `permits.json` / `.csv`: all statuses, dates, source links and parcel IDs.
- `permit_evidence.csv`: extracted numbers with source snippets and matched IDs.
- `listing_details_repaired.csv` / `repair_audit.csv`: derived repairs.
- `licensed_parcels.geojson`: actual parcel polygons with current permit records.
- `parcels/*.json`: small address tiles loaded at zoom 16+.
- `build_report.json`: counts, warnings, source links, snapshot date.
- `scanner_status.json`: local watcher's latest heartbeat; on a static published
  site it eventually displays as stale, not as an active remote scanner.

All incoming URLs remain in the table, including records without locations.
Blue circles use the saved Airbnb privacy radius without inventing a fallback.
A saved zero radius has no visible ring; unknown radii remain unknown.
Overlapping listing marker centers are spread slightly to make them clickable;
their privacy circles and permit-connection lines keep the source coordinates.
Listings outside Nashville are retained and may be governed by other rules.

## Validation

```powershell
& C:\Users\micha\anaconda3\python.exe -m unittest discover -s tests -v
# Optional UI checks: pip install playwright; requires Microsoft Edge and preview running
& C:\Users\micha\anaconda3\python.exe tests/check_browser.py
```

Browser validation uses a temporary synthetic expired permit listing because
the supplied data cannot make a real permit-number match. The fixture exists
only in that test browser's memory and never enters the generated data.


## Parcel screening, outline and difference heatmap

- `geography/davidson_county.geojson` is the official Census TIGERweb Davidson
  County outline (January 1, 2026 vintage), with its source query recorded inside.
  To explicitly refresh it: `python prepare_spatial.py --download-boundary`.
  This is a county comparison area, not a claim that all satellite cities have
  identical STR regulations.
- Airbnb circles use **saved privacy radius × (1 + leeway / 100)**. The leeway
  slider runs from 0 to +10%, default +10%. A saved zero stays zero; unknown
  stays unknown. Permit-point rings are off and hidden under Advanced filters.
- Shapely computes distance from the original Airbnb point to the nearest
  **actual current-permit parcel polygon**, using NAD83 / UTM zone 16N metres
  (EPSG:26916). This handles polygon edges, holes and multipart parcels. It does
  not compare the listing to a permit point or parcel centroid. Distances are
  cached and exported with each listing.
- ⚠️ appears when that polygon distance exceeds the adjusted privacy radius,
  within the selected analysis area. The likely-unlicensed filter uses exactly
  this test. Missing radius/geometry remains unknown, and direct permit-number
  status is kept separate. A warning is an approximation, not a legal finding.
- The signed edge buffer ranges from -1,000 to +1,000 metres in 50 m steps.
  Positive expands the county selection; negative trims its inside edge.
  The original county outline stays visible; a purple dashed outline shows the
  buffered edge. Record selection uses signed distance to the full boundary;
  rendered buffer lines are simplified by at most 3 m for performance.
- By default the displayed listings are limited to that analysis area. Turning
  off this display filter shows other listings too, but warnings and heatmap
  counts remain limited to the selected county area. Outside listings are not
  labelled unlicensed merely because Nashville permit data does not cover them.
- The **difference map** assigns each unique listing and current permit record
  once to a fixed 500 × 500 m projected grid. Red cells have more listings;
  green cells have more permit records. Cell popups show both counts and their
  signed difference. Boundary cells can extend beyond the outline, while only
  in-scope record points count. No privacy-circle overlaps are double-counted.
- The **likely-unlicensed heatmap** weights positive-difference cell centres by
  listing surplus. It is not a raw listing-density heatmap and does not identify
  which listings lack permits. Its counts use all in-scope records, independently
  of host, amenity and listing display filters. Leeway changes circle overlap and
  warnings, not fixed-grid count totals. Edge buffer changes both sets of counts.
- Multiple current records at a location count as separate permit records; a
  parcel's number of records is not inferred from its green area. Permit IDs are
  deduplicated by source ObjectId; listings by their full listing ID.
- Generated `data/spatial.json` holds the outlines and grid. `prepare_spatial.py`
  is reusable preprocessing; `website_template/spatial.js` contains the browser's
  filter and difference calculations. Reload the site after updating templates.

The preview server closes file handles before streaming responses, allowing
Windows to replace JSON files while a browser is open. A transient heartbeat
file lock is logged and retried on the next loop instead of killing the watcher.

## Hotel screening

`hotel_classification.py` checks title, host name/details, description, saved
listing text, and rental/property/room type. Evidence is exported in
`hotel_evidence`; `likely_hotel` drives orange markers and the separate footer
inventory count. Nearby-hotel references and hotel-like comparisons are ignored.
The count includes listings without coordinates; its tooltip separates mapped
and unmapped records. Hotels are excluded from spatial warnings, host warning
counts, the permit-difference heatmaps, and the hypothetical fee comparison.
These are likely classifications, not verified hotel or licensing determinations.
The module records tourism-board and hotel-operator reference sources.

Validation: `python -m unittest discover -s tests -v`, then with the preview
running, `python tests/check_hotels_browser.py` (visible Edge).
