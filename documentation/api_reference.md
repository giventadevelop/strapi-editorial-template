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
| **Advertisement Slot** | `GET /api/advertisement-slots`, `GET /api/advertisement-slots/:documentId` | Configure in Admin → Users & Permissions |
| **Sidebar Promotional Block** | `GET /api/sidebar-promotional-block` | Configure in Admin |
| **Homepage Layout** | `GET /api/homepage` | Configure in Admin |
| **Tenant** | `GET /api/tenants`, `GET /api/tenants/:documentId` | Configure in Admin (usually restricted) |
| **Editor Tenant Assignment** | `GET /api/editor-tenant-assignments`, etc. | Admin-only (no public access) |

**Note:** The seed script grants public `find` and `findOne` only for: article, category, author, global, about. For advertisement-slot, homepage, sidebar-promotional-block, grant permissions in **Settings → Users & Permissions → Public** (or use an API token with a custom role).

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
