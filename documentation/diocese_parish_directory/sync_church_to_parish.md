# Copy Church to Parish (Sync Parishes from Churches)

This document describes how to **delete all Directory – Parishes** and **recreate them from Directory – Churches**, so each parish has the same data as its matching church (name, diocese, address, contact fields, image, tenant).

## What it does

- **Deletes** all existing **Directory – Parishes** entries.
- **Creates one parish per church** with the same:
  - **Copied:** `name`, `slug` (church slug + diocese slug for uniqueness), `diocese`, `address`, `email`, `phones`, `phoneSecondary`, `addressLine1`, `addressLine2`, `city`, `state`, `postalCode`, `country`, `image`, `tenant`.
  - **Not on Parish:** Church’s `location` and `website` (Parish content type has no such fields).
  - **Left unset:** `vicar` (you can assign in Admin later if needed).

Images and tenant are copied from each church so parishes show the same media and belong to the same tenant.

## When to use it

- You have **Directory – Churches** populated (e.g. from the directory import or manually) and want **Directory – Parishes** to mirror that data.
- You want to reset parishes and repopulate them from the current church list (e.g. after fixing tenant or schema).

## Prerequisites

- **Strapi stopped** when you run the script (so the database is not locked by the server).
- **Directory – Churches** already exist with the data you want to copy (and, if you use multi-tenant, with **tenant** set on each church).

## Commands

### Run the sync (delete all parishes, then create one per church)

From the project root:

```bash
npm run sync:parishes-from-churches
```

Or run the script directly:

```bash
node scripts/sync-parishes-from-churches.js
```

### Preview only (no delete, no create)

To see how many parishes would be created and which churches would be used, without changing data:

```bash
DRY_RUN=1 npm run sync:parishes-from-churches
```

Or:

```bash
DRY_RUN=1 node scripts/sync-parishes-from-churches.js
```

## Behaviour

1. **Delete:** All documents in **Directory – Parishes** are deleted.
2. **Load churches:** All **Directory – Churches** are loaded with `diocese`, `image`, and `tenant` populated.
3. **Per church:** For each church, a parish is created with the same name, slug (church slug + diocese slug), diocese relation, address/contact fields, tenant relation, and image. The same upload file is linked to the parish so the image appears in Admin.
4. **Tenant:** If a church has a tenant, that tenant is set on the new parish (lifecycle preserves tenant when it is passed from the script). A fallback update runs after create if the tenant did not stick.

## After running

1. Restart Strapi if it was stopped: `npm run develop` (or `npm run start`).
2. In Admin, open **Content Manager → Directory – Parishes**. You should see one parish per church, with **tenant** and **image** filled when the source church had them.
3. Editors will only see parishes for their assigned tenant (via **Editor Tenant Assignment**).

## Related scripts

| Script | Purpose |
|--------|--------|
| `npm run sync:parishes-from-churches` | Delete all parishes and create one per church (this doc). |
| `npm run seed:parish-images` | Backfill parish image from matching church (same name + diocese) when parish has no image. |
| `npm run delete:directory_entries` | Delete all directory content (including parishes, churches, etc.) for a full re-import. |
| `npm run seed:data_import_seed_directory_mosc_in` | Full directory import from clone (creates churches and, in that flow, also creates parishes from church data). |

## Troubleshooting

- **Parishes have no tenant:** Ensure each **church** has a tenant set. The sync copies the church’s tenant to the parish. If churches have no tenant, run the directory import with the correct tenant, or set tenant on churches in Admin, then run the sync again.
- **Parishes have no image:** The script links the same upload file as the church. If the church has no image, the parish will not. Use `npm run seed:parish-images` to attach a matching church’s image to parishes that are missing one (by name + diocese).
- **Strapi must be stopped** when running the script to avoid database lock issues.
