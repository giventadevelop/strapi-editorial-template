# Catholicate News → Strapi Content Mapping

Reference for how each section of the Catholicate News portal maps to Strapi content types and how the frontend retrieves data.

## Page Section → Content Type Mapping

| Section | Content Type | Key Fields | How to Retrieve |
|---------|--------------|------------|-----------------|
| **Top bar** (date, social icons, search) | `Global` (single) | siteName, favicon, siteDescription, defaultSeo | `GET /api/global` |
| **Header** (logo, site title) | `Global` | siteName, favicon | `GET /api/global` |
| **Navigation** (HOME, MAIN NEWS, FEATURED NEWS, PRESS RELEASE) | Hardcoded or `Global` | — | Define in frontend or via Global config |
| **Flash News** (red scrolling bar) | `Homepage Layout` (single) | flashNewsMessage, flashNewsActive | `GET /api/homepage` |
| **Main News** | `Article` (collection) | category, tenant | Filter: `category.slug=main-news` |
| **Featured News** | `Article` (collection) | isFeatured | Filter: `isFeatured=true` |
| **Press Release** | `Article` (collection) | category | Filter: `category.slug=press-release` |
| **Most Read** | `Article` (collection) | views | Sort: `views:desc`, limit 5 |
| **Sidebar** (Facebook, video, promo) | `Sidebar Promotional Block` (single) | blockType, embedCode, videoUrl, thumbnail | `GET /api/sidebar-promotional-block` |
| **Sidebar ads** | `Advertisement Slot` (collection) | position, media, embedHtml | Filter: `position=sidebar` |
| **Footer** | `Global` | — | Extend Global or create Footer single type |

---

## Frontend API Calls (Next.js)

### 1. Featured News
```javascript
// Articles marked as featured by editors
// Note: Use filters[publishedAt][$notNull]=true instead of status=published
// Use populate[0]=... for multiple relations (comma-separated can cause 400)
const res = await fetch(
  `${STRAPI_URL}/api/articles?` +
  `filters[isFeatured][$eq]=true` +
  `&filters[tenant][tenantId][$eq]=${tenantId}` +
  `&filters[publishedAt][$notNull]=true` +
  `&populate[0]=cover&populate[1]=category&populate[2]=author` +
  `&sort=publishedAt:desc` +
  `&pagination[limit]=6`
);
```

### 2. Main News
```javascript
// Articles in "Main News" category
// Use $eqi for case-insensitive match (Strapi may store slug as "Main-News")
const res = await fetch(
  `${STRAPI_URL}/api/articles?` +
  `filters[category][slug][$eqi]=main-news` +
  `&filters[tenant][tenantId][$eq]=${tenantId}` +
  `&filters[publishedAt][$notNull]=true` +
  `&populate[0]=cover&populate[1]=category&populate[2]=author` +
  `&sort=publishedAt:desc` +
  `&pagination[limit]=10`
);
```

### 3. Press Release
```javascript
// Articles in "Press Release" category
// Use $eqi for case-insensitive match
const res = await fetch(
  `${STRAPI_URL}/api/articles?` +
  `filters[category][slug][$eqi]=press-release` +
  `&filters[tenant][tenantId][$eq]=${tenantId}` +
  `&filters[publishedAt][$notNull]=true` +
  `&populate[0]=cover&populate[1]=category&populate[2]=author` +
  `&sort=publishedAt:desc` +
  `&pagination[limit]=10`
);
```

### 4. Most Read
```javascript
// Articles sorted by view count
const res = await fetch(
  `${STRAPI_URL}/api/articles?` +
  `filters[tenant][tenantId][$eq]=${tenantId}` +
  `&filters[publishedAt][$notNull]=true` +
  `&populate[0]=cover&populate[1]=category` +
  `&sort=views:desc` +
  `&pagination[limit]=5`
);
```

### 5. Flash News
```javascript
const res = await fetch(`${STRAPI_URL}/api/homepage?populate=*`);
const { flashNewsMessage, flashNewsActive } = res.data;
// Show red bar only if flashNewsActive === true
```

### 6. Sidebar & Ads
```javascript
const sidebar = await fetch(`${STRAPI_URL}/api/sidebar-promotional-block`);
const ads = await fetch(
  `${STRAPI_URL}/api/advertisement-slots?` +
  `filters[position][$eq]=sidebar` +
  `&filters[tenant][tenantId][$eq]=${tenantId}`
);
```

---

## Required Categories (create in Strapi Admin)

Create these Category entries so articles can be filtered:

| Category name | Slug | Use for |
|---------------|------|---------|
| Main News | `main-news` | Main news section |
| Press Release | `press-release` | Press release section |
| Featured News | `featured-news` | Optional; or use isFeatured only |

**Note:** "Featured News" can work two ways:
- **Option A (recommended):** Use `isFeatured` boolean — any article in any category can be featured
- **Option B:** Use a "Featured News" category — assign articles to that category

---

## Incrementing "Most Read" (views)

The frontend must increment `views` when a user opens an article. Options:

1. **Custom Strapi controller** — `POST /api/articles/:id/view` that increments views
2. **Frontend calls PATCH** — If authenticated, PATCH the article with `views: currentViews + 1`
3. **Strapi middleware** — Track views server-side (more complex)

See `documentation/cms_setup_next_steps.html` Phase 3.2 for implementation details.
