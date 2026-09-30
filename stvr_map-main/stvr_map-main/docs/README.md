# Chatham County short-term rental maps

Published site: https://michaelwoodc.github.io/stvr_map/

## Working files

The project root contains the HTML pages, location JavaScript files, and three working CSVs:

- `county_licensed_airbnbs.csv`
- `county_unlicensed_airbnbs.csv`
- `STR Renewal List.ChathamCounty.2026.csv`

`.gitignore` remains at the root for Git configuration.

## Supporting folders

- `assets/css/` and `assets/js/`: shared map styles and submission interface code.
- `data/county_licenses/`: generated matched renewal CSV and licensed-location GeoJSON.
- `data/geography_files/`: municipality and ZIP boundaries, local parcel digest, parcel parts, and address tiles. The large parcel digest remains ignored by Git.
- `data/savannah_licenses/`: Savannah license source files and matching output.
- `notebooks/`: GeoJSON processing and license matching notebooks. Open them with a working directory anywhere inside this project; they locate the project root automatically.
- `scripts/`: parcel address index builder and host/license matcher. Their data paths resolve relative to the project, regardless of the shell working directory.
- `docs/`: this guide and form field notes.
- `server/`: PHP complaint form prototype.
- `ORRs/`: original public-records response documents.
- `data_files/`: existing source geography and intermediate listing data.
- `images/` and `media/`: existing images, artwork, and associated files.
- `archive/`: older page and location snapshots.

## Local use

Serve the project root, for example with `python -m http.server 8000`, and open `http://localhost:8000/county_licenses_map.html`. Fetch-based map data needs an HTTP server. The PHP prototype needs a PHP-capable server.

From the project root, the helper commands are:

```sh
python scripts/build_parcel_address_index.py
node scripts/match_hosts_to_licenses.mjs
```

These commands regenerate outputs; run them only when you intend to rebuild the corresponding data.

## Existing incomplete pages

The complaint pages reference `complaints.php` and `city_logo.png`, which are absent from this checkout. `districts.html` references `data_files/in_process_data/boundaries.js`, but only a Windows shortcut is present. Archived pages are historical snapshots and may contain other obsolete references.
