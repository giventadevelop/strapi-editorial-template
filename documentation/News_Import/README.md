# News Import (Catholicate News)

This folder contains documentation for importing news articles from the legacy Catholicate News site (catholicatenews.in) into Strapi.

## Overview

Four scripts support the workflow:

1. **Export** – Backup articles and categories for tenant `tenant_demo_002` before any changes
2. **Delete** – Remove all articles (categories remain)
3. **Seed** – Import up to 30 articles per category from the legacy HTML clone
4. **Fix category/tenant** – If category or tenant are empty in Content Manager after import: `npm run fix:article_category_tenant`

## Recommended Order

1. **Stop Strapi** (if running) – The seed runs in a separate process; stopping Strapi avoids SQLite locks and ensures the admin UI sees the new data after restart.
2. `npm run export:news_tenant_demo` – Backup existing data
3. `npm run delete:articles` – Wipe articles (optional: `DRY_RUN=1` first)
4. `npm run seed:news_catholicatenews` – Import from legacy clone
5. **Restart Strapi** – Refresh the admin panel; articles should appear in Content Manager → Editorial – Article.

## Prerequisites

- Local clone of catholicatenews.in at `E:\project_workspace\catholicatenews-in-temp` (or set `STRAPI_NEWS_CLONE_DIR`)
- Strapi project with Article and Category content types
- npm dependencies: `cheerio`, `dotenv`, `mime-types`

## Documentation

- [news_import_workflow.html](news_import_workflow.html) – Step-by-step guide with config, run instructions, and troubleshooting

## Published Date (createdAt / publishedAt)

The import extracts the published date from the source HTML (`<time class="entry-date published" datetime="...">` inside each article card). After creation, it sets `published_at` directly in the database so Strapi does not overwrite it with today's date.

If you previously imported and all articles show today's date on the frontend, delete articles and re-run the seed:
1. `npm run delete:articles`
2. `npm run seed:news_catholicatenews`

## Post-Import: Frontend Cover Images

If cover images show in the Strapi admin but **not on the frontend** after import, the frontend must:

1. **Populate the cover relation** — Add `populate=cover` (or `populate[0]=cover`) to the articles API request.
2. **Use full image URLs** — Strapi returns relative URLs (e.g. `/uploads/...`); prepend your Strapi base URL (e.g. `http://localhost:1337`) when rendering images.

See [API Reference §8 — Article Cover Images Not Showing on Frontend](../api_reference.md#8-article-cover-images-not-showing-on-frontend) for details and code examples.

## Reference

- Content mapping: [catholicatenews_strapi_content_mapping.md](../catholicatenews_strapi_content_mapping.md)
- Directory import (similar pattern): [phase3_import_README.html](../diocese_parish_directory/phase3_import_README.html)
