# Strapi → Frontend slug contract (Next.js)

Share this document with the **Next.js** (or any consumer) project. It defines what the frontend must use when calling the Strapi Content API. **Slug normalization is enforced in Strapi** on save; the frontend does not need to re-validate unless it **creates** content via the API.

**Related Strapi docs in this repo:**

- [catholicatenews_strapi_content_mapping.md](./catholicatenews_strapi_content_mapping.md) — full news page API examples
- [api_reference.md](./api_reference.md) — query parameters and troubleshooting
- [../.cursor/rules/strapi_production_news_tenant_categories.mdc](../.cursor/rules/strapi_production_news_tenant_categories.mdc) — tenant + slug runbook for Strapi maintainers

---

## 1. Slug format (canonical)

| Rule | Example |
|------|---------|
| Lowercase letters, numbers, hyphens only | `main-news` ✅ |
| No spaces, underscores, or mixed case in **filters** | `Main-News` ❌ (do not use in queries) |
| Pattern | `^[a-z0-9]+(?:-[a-z0-9]+)*$` |

**Strapi behavior:** On create/update, slugs are **auto-normalized** to kebab-case (e.g. `Main-News` → `main-news`). Optional server env `STRICT_KEBAB_SLUG=1` rejects invalid slugs instead of fixing them (CMS only).

---

## 2. Category slugs (hardcode in frontend)

Use these **exact** strings in `filters[category][slug][$eq]=...`:

| Section | Constant value | Strapi category name (admin) |
|---------|----------------|------------------------------|
| Main News | `main-news` | Main News |
| Featured News | `featured-news` | Featured News |
| Press Release | `press-release` | Press Release |
| Most Read (if filtered by category) | `most-read` | Most Read |

### TypeScript constants (copy to Next.js)

```typescript
/** Must match Strapi category slugs — see documentation/strapi_frontend_slug_contract.md */
export const STRAPI_NEWS_CATEGORY_SLUGS = {
  mainNews: 'main-news',
  featuredNews: 'featured-news',
  pressRelease: 'press-release',
  mostRead: 'most-read',
} as const;
```

### Example query (Main News)

```http
GET /api/articles?
  filters[tenant][tenantId][$eq]=tenant_demo_002
  &filters[category][slug][$eq]=main-news
  &filters[publishedAt][$notNull]=true
  &populate[0]=cover
  &populate[1]=category
  &populate[2]=author
  &sort=publishedAt:desc
  &pagination[limit]=10
```

Use **`$eq`** for category slug (production slugs are normalized). **`$eqi`** is only needed for legacy data that still has mixed case.

---

## 3. Article slugs (routes and links)

- **Read** `article.slug` from the API and use it **as returned** in URLs (e.g. `/news/{slug}`).
- Do **not** uppercase or rewrite slugs when displaying or linking.
- Do **not** run kebab normalization on read unless the frontend **generates** slugs before POSTing to Strapi.

---

## 4. Directory and other content types

Any Strapi type with a `slug` UID (bishops, parishes, dioceses, directory entries, tenants, etc.) follows the same rule: **lowercase kebab-case** in the API and in frontend routes.

| Content | API path | Slug in filter |
|---------|----------|----------------|
| Article | `/api/articles` | `filters[slug][$eq]=...` |
| Category | `/api/categories` | `filters[slug][$eq]=...` |
| Parish, Bishop, … | `/api/parishes`, `/api/bishops`, … | `filters[slug][$eq]=...` |

Use slug values from Strapi responses for detail pages; do not invent casing.

---

## 5. Tenant filter (required for news)

Always scope tenant content:

```http
filters[tenant][tenantId][$eq]=<NEXT_PUBLIC_TENANT_ID>
```

If tenant-scoped lists return 0 despite data in admin, also try an OR with tenant `documentId` (see `scripts/debug-production-news.mjs` in the Strapi repo).

Published articles only:

```http
filters[publishedAt][$notNull]=true
```

---

## 6. What the frontend does **not** need

| Topic | Frontend action |
|-------|-----------------|
| Kebab validation on CMS saves | None — Strapi handles it |
| `STRICT_KEBAB_SLUG` | Ignore — Strapi server env only |
| Normalizing every API response | None — trust Strapi output |
| Matching `displayName` in admin | None — API uses `pluralName` / `slug` field only |

---

## 7. Optional: frontend creates content via API

If the Next app POSTs articles or categories to Strapi, apply the same normalization before send (or rely on Strapi to fix on save):

```typescript
export function toKebabSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
```

Reference implementation: `src/utils/normalize-slug.js` in the Strapi template repo.

---

## 8. Checklist for Next.js integration

- [ ] Category section fetches use `main-news`, `featured-news`, `press-release` (constants above)
- [ ] All article/list calls include `filters[tenant][tenantId][$eq]=...` and `filters[publishedAt][$notNull]=true`
- [ ] Article detail URLs use `article.slug` from API unchanged
- [ ] No client-side assumption that category slug equals display name (`Main News` ≠ `main-news`)
- [ ] After Strapi deploy + slug backfill, verify sections return data (hard refresh / CDN if needed)

---

## 9. Changelog (Strapi side)

| Date | Change |
|------|--------|
| 2026-06 | Category slugs on Cloud normalized to kebab-case; tenant publish middleware |
| 2026-06 | All UID `slug` types normalize on save via `src/utils/normalize-slug.js` |

For Strapi operators: run `node scripts/normalize-production-slugs.mjs` on Cloud if legacy mixed-case slugs remain.
