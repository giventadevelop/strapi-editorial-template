# Strapi Content API Reference

Reference for the exposed Content API endpoints, tenant filtering, and authentication.

---

## 1. Exposed APIs (REST Content API)

Base URL: `http://localhost:1337/api` (or your Strapi server URL + `/api`)

Strapi auto-exposes REST endpoints for each content type. The following are available:

| Content Type | Endpoints | Public by default (seed) |
|--------------|-----------|--------------------------|
| **Article** | `GET /api/articles`, `GET /api/articles/:documentId` | Yes (find, findOne) |
| **Category** | `GET /api/categories`, `GET /api/categories/:documentId` | Yes |
| **Author** | `GET /api/authors`, `GET /api/authors/:documentId` | Yes |
| **Global** | `GET /api/global` | Yes |
| **About** | `GET /api/about` | Yes |
| **Advertisement Slot** | `GET /api/advertisement-slots`, `GET /api/advertisement-slots/:documentId` | Via bootstrap (public find) |
| **Flash News Item** | `GET /api/flash-news-items`, `GET /api/flash-news-items/:documentId` | Via bootstrap (public find) |
| **Sidebar Promotional Block** | `GET /api/sidebar-promotional-block` | Via bootstrap (public find) |
| **Homepage Layout** | `GET /api/homepage` | Configure in Admin |
| **Directory – Home** | `GET /api/directory-home` | Via bootstrap (public find) |
| **Directory – Bishops** | `GET /api/bishops`, `GET /api/bishops/:documentId` | Via bootstrap (public find, findOne) |
| **Directory – Dioceses** | `GET /api/dioceses`, `GET /api/dioceses/:documentId` | Via bootstrap (public find, findOne) |
| **Directory – Parishes** | `GET /api/parishes`, `GET /api/parishes/:documentId` | Via bootstrap (public find, findOne) |
| **Directory – Churches** | `GET /api/churches`, `GET /api/churches/:documentId` | Via bootstrap (public find, findOne) |
| **Directory – Priests** | `GET /api/priests`, `GET /api/priests/:documentId` | Via bootstrap (public find, findOne) |
| **Directory – Entries** | `GET /api/directory-entries`, `GET /api/directory-entries/:documentId` | Via bootstrap (public find, findOne) |
| **Tenant** | `GET /api/tenants`, `GET /api/tenants/:documentId` | Configure in Admin (usually restricted) |
| **Editor Tenant Assignment** | `GET /api/editor-tenant-assignments`, etc. | Admin-only (no public access) |

**Note:** The seed script grants public `find` and `findOne` for: article, category, author, global, about. Bootstrap also grants public find for: homepage, sidebar-promotional-block, advertisement-slot, flash-news-item, directory-home, bishop, diocese, parish, church, priest, directory-entry.

---

## 2. Passing Tenant ID with Every Request

**Tenant filtering is the client's responsibility.** The frontend must add tenant filters to every request that returns tenant-scoped content so results are naturally filtered by tenant.

### Tenant identifier

Each Tenant has a **`tenantId`** string (e.g. `tenant_mosc_001`, `tenant_demo_002`). This is the programmatic ID used for API filtering. Resolve it from your route/domain (e.g. `mosc.example.com` → `tenant_mosc_001`).

### Filter format

For collection types with a `tenant` relation (Article, Advertisement Slot, etc.):

```
filters[tenant][tenantId][$eq]=<tenantId>
```

Example: `filters[tenant][tenantId][$eq]=tenant_mosc_001`

### Example requests

```http
# Articles for a tenant (use filters[publishedAt][$notNull]=true for draft/publish types; use populate[0]=... for multiple relations)
GET /api/articles?filters[tenant][tenantId][$eq]=tenant_mosc_001&filters[publishedAt][$notNull]=true&populate[0]=cover&populate[1]=category&populate[2]=author&sort=publishedAt:desc&pagination[limit]=10

# Advertisement slots for a tenant (sidebar)
GET /api/advertisement-slots?filters[tenant][tenantId][$eq]=tenant_mosc_001&filters[position][$eq]=sidebar

# Flash News Items for a tenant (carousel/ticker)
GET /api/flash-news-items?filters[tenant][tenantId][$eq]=tenant_mosc_001&filters[publishedAt][$notNull]=true&sort=order:asc&populate[0]=article&pagination[limit]=20

# Main News for a tenant
GET /api/articles?filters[tenant][tenantId][$eq]=tenant_mosc_001&filters[category][slug][$eq]=main-news&filters[publishedAt][$notNull]=true
```

### Next.js helper

```javascript
// Resolve tenantId from hostname or route (e.g. mosc.example.com → tenant_mosc_001)
const tenantId = getTenantIdFromRequest(req); // your logic

const url = `${STRAPI_URL}/api/articles?` +
  `filters[tenant][tenantId][$eq]=${encodeURIComponent(tenantId)}` +
  `&filters[publishedAt][$notNull]=true` +
  `&populate=cover,category,author` +
  `&sort=publishedAt:desc`;
```

---

## 2.1 Flash News Items API

Scrolling flash news carousel/ticker items. Each item can link to an article or an external URL.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/flash-news-items` | List flash news items (tenant-scoped) |
| GET | `/api/flash-news-items/:documentId` | Single flash news item by documentId |

### Query parameters (list)

| Parameter | Required | Description |
|-----------|----------|-------------|
| `filters[tenant][tenantId][$eq]` | Yes | Tenant ID (e.g. `tenant_mosc_001`) |
| `filters[publishedAt][$notNull]` | Recommended | Only published items (`true`) |
| `sort` | No | `order:asc` (display order), or `order:asc,publishedAt:desc` |
| `populate[0]` | No | `article` — to get linked article (slug, title) for href |
| `pagination[limit]` | No | Default 25; use e.g. `20` for carousel |
| `pagination[page]` | No | For pagination |

### Response fields

| Field | Type | Description |
|-------|------|-------------|
| `documentId` | string | Unique document ID |
| `title` | string | Entry title (admin / label) |
| `content` | string | Ticker text shown in carousel |
| `article` | object \| null | Related article (when populated); use `article.slug` for internal link |
| `externalUrl` | string \| null | External link when no article |
| `order` | number | Display order (lower = first) |
| `startDate` | string \| null | ISO date; show only on or after this date |
| `endDate` | string \| null | ISO date; show only on or before this date |
| `publishedAt` | string \| null | Publication timestamp |

### Frontend integration example

```javascript
// Fetch flash news items for the current tenant
const tenantId = getTenantIdFromRequest(req); // e.g. from hostname or route

const res = await fetch(
  `${STRAPI_URL}/api/flash-news-items?` +
  `filters[tenant][tenantId][$eq]=${encodeURIComponent(tenantId)}` +
  `&filters[publishedAt][$notNull]=true` +
  `&sort=order:asc` +
  `&populate[0]=article` +
  `&pagination[limit]=20`,
  {
    headers: process.env.STRAPI_API_TOKEN
      ? { Authorization: `Bearer ${process.env.STRAPI_API_TOKEN}` }
      : {},
  }
);
const { data } = await res.json();

// Filter by startDate/endDate client-side (optional)
const today = new Date().toISOString().split('T')[0];
const visible = data.filter((item) => {
  if (item.startDate && item.startDate > today) return false;
  if (item.endDate && item.endDate < today) return false;
  return true;
});

// Build link for each item
visible.forEach((item) => {
  const href = item.article?.slug
    ? `/article/${item.article.slug}` // or your article route
    : item.externalUrl || '#';
  // Render: item.content, href
});
```

### Next.js (Server Component)

```javascript
export default async function FlashNewsCarousel() {
  const tenantId = process.env.TENANT_ID; // or from headers/params

  const res = await fetch(
    `${process.env.STRAPI_URL}/api/flash-news-items?` +
    `filters[tenant][tenantId][$eq]=${tenantId}` +
    `&filters[publishedAt][$notNull]=true` +
    `&sort=order:asc` +
    `&populate[0]=article` +
    `&pagination[limit]=20`,
    {
      next: { revalidate: 60 }, // revalidate every 60 seconds
      headers: process.env.STRAPI_API_TOKEN
        ? { Authorization: `Bearer ${process.env.STRAPI_API_TOKEN}` }
        : {},
    }
  );
  const { data } = await res.json();

  return (
    <div className="flash-news-carousel">
      {data?.map((item) => {
        const href = item.article?.slug
          ? `/news/${item.article.slug}`
          : item.externalUrl || '#';
        return (
          <a key={item.documentId} href={href}>
            {item.content}
          </a>
        );
      })}
    </div>
  );
}
```

### Notes

- **Date filtering:** `startDate` and `endDate` are optional. Filter client-side if you want items to show only within a date range.
- **Link priority:** Use `article.slug` for internal links; fall back to `externalUrl` when no article is linked.
- **Populate:** Use `populate[0]=article` to get article data (slug, title) for building hrefs. Use `populate[0]=article&populate[1]=article.cover` if you need the article cover image.

---

## 3. API Token & Client Credentials

### Where the API token comes from

API tokens are created in **Strapi Admin**:

1. Go to **Settings** (gear icon) → **API Tokens** (under Global Settings).
2. Click **Create new API Token**.
3. Name it (e.g. "Frontend app").
4. Choose a **Token type**:
   - **Read-only** — for read-only access.
   - **Full access** — for create/update/delete (use only server-side, never in browser).
5. Set an expiration (or leave empty for no expiry).
6. **Save** — Strapi shows the token **once**. Copy and store it securely (e.g. in `.env`).

### How the client passes the token

Send the token in the **Authorization** header:

```http
Authorization: Bearer <your-api-token>
```

Example (fetch):

```javascript
const res = await fetch(
  `${STRAPI_URL}/api/articles?filters[tenant][tenantId][$eq]=${tenantId}`,
  {
    headers: {
      Authorization: `Bearer ${process.env.STRAPI_API_TOKEN}`,
    },
  }
);
```

### Public vs authenticated

- **Public role:** If the Public role has permission for an action (e.g. `find` on Article), no token is needed. Requests work without `Authorization`.
- **API token:** Use when you need access beyond the Public role (e.g. non-public content types) or when you want to restrict API usage to token holders.

### Environment variable

Store the token in `.env` (server-side only):

```
STRAPI_API_TOKEN=your-generated-token-here
```

Never expose the token in client-side JavaScript (e.g. `NEXT_PUBLIC_*`) if it has write permissions.

---

## 4. Quick reference

| Item | Value |
|------|-------|
| Content API base | `http://localhost:1337/api` |
| Tenant filter | `filters[tenant][tenantId][$eq]=<tenantId>` |
| Auth header | `Authorization: Bearer <api-token>` |
| API token location | Settings → API Tokens (create in Admin) |

For detailed frontend examples, see `documentation/catholicatenews_strapi_content_mapping.md`.

For **directory-related APIs** (Directory Home, Bishops, Dioceses, Parishes, Churches, Priests, Directory Entries) with full field definitions and examples, see `documentation/directory_api_reference.md`.

---

## 5. Encryption key (viewing tokens in Admin)

If you see *"In order to view the token, you need a valid encryption key in the admin configuration"*, tokens are created but Strapi cannot decrypt and display them. Fix it as follows.

### Step 1 — Generate an encryption key

Run in your project root:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Copy the output (e.g. `aB3xY9kL...`).

### Step 2 — Add to `.env`

Add or update:

```
ENCRYPTION_KEY=<paste the generated key here>
```

Ensure `config/admin.js` has:

```javascript
secrets: {
  encryptionKey: env('ENCRYPTION_KEY'),
},
```

### Step 3 — Restart Strapi

Restart Strapi so the new config is loaded.

### Step 4 — Give the token to the client

- **Existing tokens** created before the encryption key was set cannot be viewed or recovered. Delete them and create new ones.
- **New tokens** created after setting `ENCRYPTION_KEY` will be viewable in Admin at any time (with a copy button).
- When creating a new token, click **Save** — the token appears once at the top. Use the copy button and send it securely to the client (e.g. via a secure channel, secrets manager, or `.env`).

The client uses it as: `Authorization: Bearer <token>`.

---

## 6. Troubleshooting 400 Bad Request on Article API

If `GET /api/articles` returns **400** while `GET /api/advertisement-slots` works:

1. **Avoid `status=published`** — Use `filters[publishedAt][$notNull]=true` instead. Some Strapi 5 setups reject the `status` query param.
2. **Use array syntax for populate** — Replace `populate=cover,category,author` with:
   ```
   populate[0]=cover&populate[1]=category&populate[2]=author
   ```
3. **Or use `populate=*`** — To populate all relations one level deep: `populate=*`

Example that should work:
```
GET /api/articles?filters[tenant][tenantId][$eq]=tenant_demo_002&filters[publishedAt][$notNull]=true&populate[0]=cover&populate[1]=category&populate[2]=author&sort=publishedAt:desc&pagination[limit]=6
```

---

## 7. Why filters return 0 items (data mismatch)

### Category slug case sensitivity

If **Main News** returns 0 items but **Most Read** (no category filter) returns items, the category slug likely does not match. Strapi may store the slug as `Main-News` (from the name "Main News") while the filter uses `main-news`.

**Fix:** Use the case-insensitive operator `$eqi`:
```
filters[category][slug][$eqi]=main-news
```
This matches `main-news`, `Main-News`, `MAIN-NEWS`, etc.

### Advertisement position mismatch

If ads return 0 items, the filter may not match your data. The frontend filters for `position=sidebar`, but your only ad has `position=top`.

**Fix:** Either create an Advertisement Slot with position `sidebar` in Strapi, or have the frontend also fetch ads with `position=top` for the top banner.

### Homepage and sidebar-promotional-block 404

These single types need public find permission. Restart Strapi after the bootstrap runs — it now grants public `find` for `homepage`, `sidebar-promotional-block`, and `advertisement-slot`.

---

## 8. Article Cover Images Not Showing on Frontend

If article cover images appear correctly in the Strapi admin panel but **do not show on the frontend** after import or in production, check the following.

### 1. Populate the cover relation

The `cover` field is a media relation. By default, Strapi does **not** include relations in the response. You must explicitly populate it:

```http
GET /api/articles?...&populate[0]=cover&populate[1]=category&populate[2]=author
```

Or using the shorthand:

```http
GET /api/articles?...&populate=cover,category,author
```

Without `populate=cover`, the response will have `cover: null` or an empty object, so no image can be displayed.

### 2. Use the full image URL

Strapi returns image URLs as **relative paths** (e.g. `/uploads/asmara_2_1024x543_abc123.jpg`). The frontend must prepend the Strapi base URL to build a working image URL.

```javascript
const STRAPI_URL = process.env.STRAPI_URL || 'http://localhost:1337';

// After fetching article with populate=cover
const cover = article.cover;
let imageUrl = null;
if (cover?.url) {
  // Prepend Strapi base URL if url is relative
  imageUrl = cover.url.startsWith('http')
    ? cover.url
    : `${STRAPI_URL}${cover.url.startsWith('/') ? '' : '/'}${cover.url}`;
}

// Use imageUrl in <img src={imageUrl} alt={article.title} />
```

### 3. Verify the cover in the API response

Call the API directly and inspect the response:

```http
GET http://localhost:1337/api/articles?populate=cover&pagination[limit]=1
```

Check that `data[0].cover` is an object with `url`, `alternativeText`, etc. If `cover` is null, the article has no cover assigned, or the relation was not populated.

### Summary

| Cause | Fix |
|-------|-----|
| Cover not populated | Add `populate=cover` (or `populate[0]=cover`) to the articles API request |
| Relative URL not resolved | Prepend `STRAPI_URL` (e.g. `http://localhost:1337`) to `cover.url` when rendering images |
