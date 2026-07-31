# News Import (Catholicate News)

This folder documents importing news from [catholicatenews.in](https://catholicatenews.in/) into Strapi (local), then syncing to **Strapi Cloud** for production.

## Overview

| Step | npm script | Purpose |
|------|------------|---------|
| Export | `export:news_tenant_demo` | Backup articles/categories before wipe |
| Delete | `delete:articles` | Remove articles (categories kept) |
| Seed articles | `seed:news_catholicatenews` | Import from clone or `--live` scrape |
| Seed ads + flash | `seed:ads-flash-catholicatenews` | Live homepage scrape → ad slots + flash |
| Enrich full descriptions | `enrich:article-descriptions-catholicatenews` | Scrape article detail pages → fill `description` |
| Fix category/tenant | `fix:article_category_tenant` | Repair empty category/tenant in CM |
| Push to Cloud | `push:tenant-to-cloud` | Upsert articles / flash / ads |
| Restore dates | `sync:article-published-dates-cloud` | Fix `publishedAt` after Cloud publish |
| S3 images | `push:collection-images-s3-to-cloud` | Durable covers / ad media |
| Repair orchestrator | `repair:cloud-news-sync` | Shell cleanup + re-push + S3 + tenant re-link |

## Recommended order (local)

1. **Stop Strapi** (avoids SQLite locks; admin sees data after restart).
2. `npm run export:news_tenant_demo` — backup.
3. `npm run delete:articles` — optional wipe (`DRY_RUN=1` first).
4. Seed articles, then **enrich full descriptions**, then ads/flash (see commands below).
5. **Restart Strapi** — Content Manager → Editorial – Article / Ads / Flash.

## Local scrape commands

```bash
# Articles from live site (last 12 months), both tenants
npm run seed:news_catholicatenews -- --live --months=12 --tenants=tenant_demo_002,mosc_malankara_orthodox_2

# Fill full article bodies (seed only stores listing excerpts)
npm run enrich:article-descriptions-catholicatenews -- --tenants=tenant_demo_002,mosc_malankara_orthodox_2

# Ads + flash from live homepage (positions: top, between_sections, sidebar)
npm run seed:ads-flash-catholicatenews -- --tenants=tenant_demo_002,mosc_malankara_orthodox_2
```

The initial news seed only stores the **card excerpt** from category listings. Run `enrich:article-descriptions-catholicatenews` afterward so Editorial – Article `description` has the full body from each [catholicatenews.in](https://catholicatenews.in/) detail page. Updates write via DB (avoids Document Service wiping tenant).

Ad position mapping (frontend):

- `top` ← header banner (`.top-add`)
- `between_sections` ← first mid-page square promo
- `sidebar` ← remaining square promos

## Production Cloud sync

**Tenant:** `mosc_malankara_orthodox_2` (live). Demo: `tenant_demo_002`.

**Images:** use durable S3 (`--skip-api`), not ephemeral Cloud `/uploads/`. See `.cursor/rules/strapi-cloud-production-durable-s3-image-upload-not-ephemeral-uploads.mdc`.

```bash
# PowerShell if TLS issues:
$env:NODE_TLS_REJECT_UNAUTHORIZED='0'

npm run push:tenant-to-cloud -- --tenant-id=mosc_malankara_orthodox_2 --types=articles,flash-news-items,advertisement-slots --force --delay-ms=80
npm run sync:article-published-dates-cloud -- --tenant-id=mosc_malankara_orthodox_2
npm run push:collection-images-s3-to-cloud -- --collection=articles --tenant-id=mosc_malankara_orthodox_2 --skip-api
npm run push:collection-images-s3-to-cloud -- --collection=advertisement-slots --tenant-id=mosc_malankara_orthodox_2 --skip-api

# After S3 cover link, re-link tenants (cover PUT can drop tenant)
npm run repair:cloud-news-sync -- --tenant-id=mosc_malankara_orthodox_2
```

Full runbook: [news-production-cloud-push-prd.html](../front_end_based_collection_types_import/production_cloud_data_push/news-production-cloud-push-prd.html)

## Prerequisites

- Clone path or `--live` scrape; `cheerio`, `dotenv`, `mime-types`
- Cloud: `STRAPI_CLOUD_URL`, `STRAPI_CLOUD_API_TOKEN`, AWS S3 credentials

## Documentation

- [news_import_workflow.html](news_import_workflow.html) — local step-by-step
- [news-production-cloud-push-prd.html](../front_end_based_collection_types_import/production_cloud_data_push/news-production-cloud-push-prd.html) — Cloud + S3
- Content mapping: [catholicatenews_strapi_content_mapping.md](../catholicatenews_strapi_content_mapping.md)

## Published date note

Import sets `published_at` in DB so Strapi does not overwrite with today. After Cloud push/publish, always run `sync:article-published-dates-cloud`.

## Post-Import: Frontend Cover Images

1. Populate `cover` (and ads `media`) on API requests.
2. Prefer absolute S3 URLs from Cloud; for local relative `/uploads/…`, prepend Strapi base URL.

See [API Reference §8](../api_reference.md#8-article-cover-images-not-showing-on-frontend).
