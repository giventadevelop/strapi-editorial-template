# Phase 3 – Directory import from local clone

This document describes how to run the automated import of directory data from the local clone of [directory.mosc.in](https://directory.mosc.in/) into Strapi.

## Prerequisites

1. **Local clone** of the directory site (set `STRAPI_DATA_IMPORT_PROJECT_CLONE_DIR` in `.env`, or see **How to run**).
2. **Strapi** project with Phase 1 (schema) and Phase 2 (permissions) applied.
3. **cheerio**, **dotenv** installed: run `npm install` in the project root.

## What the script does

- **Parses** (with Cheerio):
  - **Dioceses** from `dioceses/index.html` (name, slug, address, email, phones, website, image).
  - **Bishops** from `bishops/index.html@the-holy-synod=diocesan-bishops.html`, `retired-bishops.html`, `the-primate.html` (name, slug, bishopType, address, email, phones, image).
  - **Directory entries** from `directories/index.html@type=*.html` for all seven types (name, slug, directoryType, address, email, phones, website, image).
  - **Priests** from diocese-based priest list pages when present (see below). The live site lists priests by diocese (e.g. [priests/?diocese=637](https://directory.mosc.in/priests/?search=&diocese=637)); the script looks for saved HTML for each diocese and imports name, title, address, email, phones, image, and diocese relation.
  - **Churches** from parish list pages when present (see **Church list pages**). The live site lists churches by diocese (e.g. [parishes/?diocese=573](https://directory.mosc.in/parishes/?diocese=573)); the script creates **Directory – Churches** and randomly assigns 2 priests (same diocese) per church for sample data.
- **Creates** in Strapi (in order): Tenant (if missing) → Dioceses → Bishops → Directory entries → Priests → Churches (then assigns 2 priests per church).
- **Uploads media**: images from the clone are uploaded to Strapi and attached to dioceses, bishops, directory entries, priests, and churches when the HTML references local image files under the clone (e.g. `../assets/upload/...`).

## How to run

From the project root:

```bash
npm run seed:data_import_seed_directory_mosc_in
```

Or with custom paths (script still loads `.env`):

```bash
# Windows (PowerShell)
$env:STRAPI_DATA_IMPORT_PROJECT_CLONE_DIR = "E:\project_workspace\directory-mosc-in-temp"
$env:TENANT_ID = "directory_mosc_001"
node scripts/data_import_seed_directory_mosc_in.js

# Linux / macOS
STRAPI_DATA_IMPORT_PROJECT_CLONE_DIR=/path/to/clone TENANT_ID=directory_mosc_001 node scripts/data_import_seed_directory_mosc_in.js
```

## Delete all directory entries

To wipe all Directory content (Bishops, Churches, Dioceses, Entries, Parishes, Priests) before a clean re-import:

```bash
npm run delete:directory_entries
```

To only see how many entries would be deleted (no changes):

```bash
DRY_RUN=1 npm run delete:directory_entries
```

Run with Strapi stopped (or from another terminal). Then run the import again (see **How to run** above).

- **STRAPI_DATA_IMPORT_PROJECT_CLONE_DIR** (read from `.env`; path to clone; fallback: `CLONE_DIR`) – Path to the directory-mosc.in clone (default: `directory_mosc_001`); script creates it if missing.
- **TENANT_ID** – Read from `.env`; tenant for imported content (default: `directory_mosc_001`); script creates it if missing.
- **STRAPI_DIRECTORY_FETCH_MISSING_PAGES** – Optional; set to `1` to fetch priest/church list pages from the live site when not in the clone.

## Priest list pages

The online directory shows priests per diocese (e.g. **List by Diocese** → Diocese of Adoor- Kadampanad). To import priests, save the corresponding HTML for each diocese into your clone so the script can find it. The script looks for:

- `priests/priests.html@diocese=<id>.html`
- `priests/index.html@diocese=<id>.html`
- `priests@diocese=<id>.html` or `priests.html@diocese=<id>.html` at clone root

where `<id>` is the diocese value from `priests.html` (e.g. `637` for Diocese of Adoor- Kadampanad). Your clone may not have these exact filenames. **Discovery:** the script also scans `priests/` for any HTML that looks like a list (e.g. contains "Diocese : …") and infers diocese from content or filename. **Optional fetch:** set `STRAPI_DIRECTORY_FETCH_MISSING_PAGES=1` in `.env` to fetch `https://directory.mosc.in/priests/?diocese=<id>` when no local list is found; only local clone paths are used for media.

## Church list pages

The online directory shows churches (parishes) per diocese (e.g. [parishes/?diocese=573](https://directory.mosc.in/parishes/?diocese=573)). To import **Directory – Churches**, save the corresponding HTML for each diocese. The script looks for:

- `parishes/parishes.html@diocese=<id>.html`
- `parishes/index.html@diocese=<id>.html`
- `parishes@diocese=<id>.html` or `parishes.html@diocese=<id>.html` at clone root

where `<id>` is the diocese value from `parishes/index.html` (e.g. `573` for Diocese of Thiruvananthapuram). **Discovery:** the script also scans `parishes/` for list-like HTML. **Optional fetch:** with `STRAPI_DIRECTORY_FETCH_MISSING_PAGES=1` it fetches `https://directory.mosc.in/parishes/?diocese=<id>` when no local list exists. For each church created, the script randomly assigns 2 priests from the same diocese (sample data). **Note:** the clone folder `directories/` holds type-based listing pages and per-entry subfolders; it is used for Directory entries only, not for diocese-filtered priest/church lists.

## After import

1. Open Strapi Admin and check **Directory – Dioceses**, **Directory – Bishops**, **Directory – Entries**, **Directory – Priests**, and **Directory – Churches** (when list pages were present).
2. **Editor role:** If an editor logs in and sees e.g. "31 entries found" but "No content found" in the list, they are not assigned to the directory tenant. Assign their email to the same tenant via **Editor Tenant Assignment**: create an entry with their login email and the tenant used for import (e.g. `tenant_demo_002`). Or run:
   `node scripts/assign-editor-to-directory-tenant.js editor@example.com`
   Then have the editor log out and log back in.
3. To show directory data on the frontend, filter by tenant, e.g.
   `GET /api/dioceses?filters[tenant][tenantId][$eq]=directory_mosc_001`.
4. Optionally create **Directory – Home** section cards manually (or extend the script to parse `index.html` and create the Directory Home single type).
5. **Directory – Parishes** (administrative unit) is a separate content type and is **not** populated by this script; add parishes manually. **Directory – Churches** is populated from parish/church list pages when present (see Church list pages); if you see 0 churches, add list pages or set `STRAPI_DIRECTORY_FETCH_MISSING_PAGES=1`. **Directory – Priests** is populated from priest list pages when present (see Priest list pages).
6. **Images:** If bishop/diocese/entry images show as missing in the admin, they were skipped during import (e.g. upload relation issue). You can attach images manually per entry, or re-run after fixing image paths in the clone.

## Re-running

The import script does not check for existing entries. Re-running it will create duplicates. To re-import cleanly: run `npm run delete:directory_entries` (see **Delete all directory entries** above), then run `npm run seed:data_import_seed_directory_mosc_in` again. Alternatively, delete directory content manually in Admin or clear the database.
