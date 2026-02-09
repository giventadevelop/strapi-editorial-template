# Directory API Reference

Reference for all directory-related Content API endpoints, content types, and field definitions. Use this with the frontend to know the shape of each directory resource.

**Base URL:** `http://localhost:1337/api` (or your Strapi server URL + `/api`)

**Tenant filtering:** All directory collection types and the Directory Home single type are tenant-scoped. The frontend must pass:

```
filters[tenant][tenantId][$eq]=<tenantId>
```

for list requests. For single-type `GET /api/directory-home`, use the same filter so the correct tenant’s directory home is returned (implementation may use a query param or header depending on your setup).

---

## 1. Directory endpoints overview

| Content Type | Endpoints | Description |
|--------------|-----------|-------------|
| **Directory – Home** | `GET /api/directory-home` | Single type: landing intro + section cards |
| **Directory – Bishops** | `GET /api/bishops`, `GET /api/bishops/:documentId` | Bishops (catholicos / diocesan / retired) |
| **Directory – Dioceses** | `GET /api/dioceses`, `GET /api/dioceses/:documentId` | Dioceses with parishes, churches, priests |
| **Directory – Parishes** | `GET /api/parishes`, `GET /api/parishes/:documentId` | Parishes under a diocese, optional vicar |
| **Directory – Churches** | `GET /api/churches`, `GET /api/churches/:documentId` | Churches (places of worship) per diocese |
| **Directory – Priests** | `GET /api/priests`, `GET /api/priests/:documentId` | Priests with diocese, optional parish/church |
| **Directory – Entries** | `GET /api/directory-entries`, `GET /api/directory-entries/:documentId` | Institutions, committees, pilgrim centres, etc. |

All of the above support public `find` / `findOne` when granted via bootstrap (see main `documentation/api_reference.md`).

---

## 2. Directory – Home (single type)

Landing page for the directory: intro text and repeatable section cards (e.g. Bishops, Dioceses, Parishes).

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/directory-home` | Single directory home (tenant-scoped) |

### Query parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `filters[tenant][tenantId][$eq]` | Yes | Tenant ID (e.g. `tenant_mosc_001`) |

### Response fields

| Field | Type | Description |
|-------|------|-------------|
| `documentId` | string | Unique document ID |
| `introText` | string (text) \| null | Optional intro text for the directory home page |
| `sectionCards` | array | Repeatable section cards (see Section Card below) |
| `tenant` | object \| null | Tenant relation (optional to populate) |

### Section Card (component inside `sectionCards`)

Each element of `sectionCards` has:

| Field | Type | Description |
|-------|------|-------------|
| `image` | object \| null | Media (image) for the card |
| `title` | string | Card title (e.g. "Bishops", "Dioceses") |
| `description` | string \| null | Optional description |
| `linkUrl` | string \| null | URL for the section (e.g. `/directory/bishops`, `/directory/dioceses`) |

### Example request

```http
GET /api/directory-home?filters[tenant][tenantId][$eq]=tenant_mosc_001
```

Populate section card images if needed:

```http
GET /api/directory-home?filters[tenant][tenantId][$eq]=tenant_mosc_001&populate[sectionCards][populate][0]=image
```

---

## 3. Directory – Bishops

Bishops: catholicos, diocesan, or retired. Optional diocese for diocesan bishops.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/bishops` | List bishops (tenant-scoped) |
| GET | `/api/bishops/:documentId` | Single bishop by documentId |

### Query parameters (list)

| Parameter | Required | Description |
|-----------|----------|-------------|
| `filters[tenant][tenantId][$eq]` | Yes | Tenant ID |
| `filters[bishopType][$eq]` | No | `catholicos`, `diocesan`, or `retired` |
| `sort` | No | e.g. `order:asc`, `name:asc` |
| `populate[0]` | No | `diocese` — diocese relation |
| `populate[1]` | No | `image` — profile image |
| `pagination[page]`, `pagination[pageSize]` | No | Pagination |

### Response fields

| Field | Type | Description |
|-------|------|-------------|
| `documentId` | string | Unique document ID |
| `name` | string | Full title/name (e.g. H. G. Dr. Thomas Mar Athanasius Metropolitan) |
| `slug` | string | UID from name (for URLs) |
| `image` | object \| null | Profile image (media) |
| `address` | string \| null | Address text |
| `email` | string \| null | Email |
| `phones` | string \| null | Phone number(s), comma-separated if multiple |
| `bishopType` | string | Enum: `catholicos`, `diocesan`, `retired` |
| `diocese` | object \| null | Related diocese (when populated) |
| `order` | number | Display order within same bishopType (default 0) |
| `tenant` | object \| null | Tenant relation (optional to populate) |

### Example request

```http
GET /api/bishops?filters[tenant][tenantId][$eq]=tenant_mosc_001&filters[bishopType][$eq]=diocesan&populate[0]=diocese&populate[1]=image&sort=order:asc
```

---

## 4. Directory – Dioceses

Dioceses with contact info and relations to parishes, churches, and priests.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/dioceses` | List dioceses (tenant-scoped) |
| GET | `/api/dioceses/:documentId` | Single diocese by documentId |

### Query parameters (list)

| Parameter | Required | Description |
|-----------|----------|-------------|
| `filters[tenant][tenantId][$eq]` | Yes | Tenant ID |
| `sort` | No | e.g. `name:asc` |
| `populate[0]` | No | `parishes` — parishes in this diocese |
| `populate[1]` | No | `churches` — churches in this diocese |
| `populate[2]` | No | `priests` — priests in this diocese |
| `populate[3]` | No | `image` — diocese image |
| `pagination[page]`, `pagination[pageSize]` | No | Pagination |

### Response fields

| Field | Type | Description |
|-------|------|-------------|
| `documentId` | string | Unique document ID |
| `name` | string | Diocese name |
| `slug` | string | UID from name (for URLs) |
| `address` | string \| null | Address text |
| `email` | string \| null | Email |
| `phones` | string \| null | Phone number(s), comma-separated if multiple |
| `website` | string \| null | Website URL |
| `image` | object \| null | Image (media) |
| `description` | string \| null | Description text |
| `parishes` | array | Parishes in this diocese (when populated) |
| `churches` | array | Churches in this diocese (when populated) |
| `priests` | array | Priests in this diocese (when populated) |
| `tenant` | object \| null | Tenant relation (optional to populate) |

### Example request

```http
GET /api/dioceses?filters[tenant][tenantId][$eq]=tenant_mosc_001&populate[0]=parishes&populate[1]=churches&populate[2]=image&sort=name:asc
```

---

## 5. Directory – Parishes

Parishes under a diocese, with optional vicar (priest) and structured address fields.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/parishes` | List parishes (tenant-scoped) |
| GET | `/api/parishes/:documentId` | Single parish by documentId |

### Query parameters (list)

| Parameter | Required | Description |
|-----------|----------|-------------|
| `filters[tenant][tenantId][$eq]` | Yes | Tenant ID |
| `filters[diocese][documentId][$eq]` | No | Filter by diocese documentId |
| `filters[diocese][slug][$eq]` | No | Filter by diocese slug |
| `sort` | No | e.g. `name:asc` |
| `populate[0]` | No | `diocese` — diocese relation |
| `populate[1]` | No | `vicar` — current vicar (priest) |
| `pagination[page]`, `pagination[pageSize]` | No | Pagination |

### Response fields

| Field | Type | Description |
|-------|------|-------------|
| `documentId` | string | Unique document ID |
| `name` | string | Parish name |
| `slug` | string | UID from name (for URLs) |
| `diocese` | object | Related diocese (required) |
| `vicar` | object \| null | Current vicar (priest) for this parish (when populated) |
| `address` | string \| null | Full address (freeform) |
| `email` | string \| null | Email |
| `phones` | string \| null | Phone number(s), comma-separated if multiple |
| `phoneSecondary` | string \| null | Second phone number |
| `addressLine1` | string \| null | Street / area |
| `addressLine2` | string \| null | Additional line |
| `city` | string \| null | City / town |
| `state` | string \| null | State / region |
| `postalCode` | string \| null | PIN / ZIP |
| `country` | string \| null | Country |
| `tenant` | object \| null | Tenant relation (optional to populate) |

### Example request

```http
GET /api/parishes?filters[tenant][tenantId][$eq]=tenant_mosc_001&filters[diocese][slug][$eq]=mosc&populate[0]=diocese&populate[1]=vicar&sort=name:asc
```

---

## 6. Directory – Churches

Churches (places of worship) with diocese, optional priests, and address/contact fields (India, Kerala, USA formats).

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/churches` | List churches (tenant-scoped) |
| GET | `/api/churches/:documentId` | Single church by documentId |

### Query parameters (list)

| Parameter | Required | Description |
|-----------|----------|-------------|
| `filters[tenant][tenantId][$eq]` | Yes | Tenant ID |
| `filters[diocese][documentId][$eq]` | No | Filter by diocese documentId |
| `filters[diocese][slug][$eq]` | No | Filter by diocese slug |
| `sort` | No | e.g. `name:asc`, `location:asc` |
| `populate[0]` | No | `diocese` — diocese relation |
| `populate[1]` | No | `priests` — priests associated with this church |
| `populate[2]` | No | `image` — church image |
| `pagination[page]`, `pagination[pageSize]` | No | Pagination |

### Response fields

| Field | Type | Description |
|-------|------|-------------|
| `documentId` | string | Unique document ID |
| `name` | string | Church name |
| `slug` | string | UID from name (for URLs) |
| `location` | string \| null | Short location label (e.g. Aduthala, Nanthancode) |
| `address` | string \| null | Full address (freeform) |
| `addressLine1` | string \| null | Street / area (India, USA) |
| `addressLine2` | string \| null | Additional line |
| `city` | string \| null | City / town |
| `state` | string \| null | State / region (e.g. Kerala, Texas) |
| `postalCode` | string \| null | PIN / ZIP |
| `country` | string \| null | Country (India, USA, etc.) |
| `phones` | string \| null | Phone number(s), comma-separated |
| `phoneSecondary` | string \| null | Second phone number |
| `email` | string \| null | Email |
| `website` | string \| null | Website URL |
| `image` | object \| null | Image (media) |
| `diocese` | object | Related diocese (required) |
| `priests` | array | Priests associated with this church (when populated) |
| `tenant` | object \| null | Tenant relation (optional to populate) |

### Example request

```http
GET /api/churches?filters[tenant][tenantId][$eq]=tenant_mosc_001&populate[0]=diocese&populate[1]=image&sort=name:asc
```

---

## 7. Directory – Priests

Priests with diocese, optional parish (as vicar), optional church, and contact info.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/priests` | List priests (tenant-scoped) |
| GET | `/api/priests/:documentId` | Single priest by documentId |

### Query parameters (list)

| Parameter | Required | Description |
|-----------|----------|-------------|
| `filters[tenant][tenantId][$eq]` | Yes | Tenant ID |
| `filters[diocese][documentId][$eq]` | No | Filter by diocese documentId |
| `filters[diocese][slug][$eq]` | No | Filter by diocese slug |
| `filters[parish][documentId][$eq]` | No | Filter by parish (vicar of that parish) |
| `sort` | No | e.g. `name:asc` |
| `populate[0]` | No | `diocese` — diocese relation |
| `populate[1]` | No | `parish` — parish where this priest is vicar |
| `populate[2]` | No | `church` — church relation |
| `populate[3]` | No | `image` — profile image |
| `pagination[page]`, `pagination[pageSize]` | No | Pagination |

### Response fields

| Field | Type | Description |
|-------|------|-------------|
| `documentId` | string | Unique document ID |
| `name` | string | Priest name |
| `slug` | string | UID from name (for URLs) |
| `title` | string \| null | e.g. Vicar, Fr. |
| `diocese` | object | Related diocese (required) |
| `parish` | object \| null | Parish where this priest is vicar (when populated) |
| `church` | object \| null | Church this priest is associated with (when populated) |
| `address` | string \| null | Address text |
| `email` | string \| null | Email |
| `phones` | string \| null | Phone number(s), comma-separated if multiple |
| `image` | object \| null | Profile image (media) |
| `tenant` | object \| null | Tenant relation (optional to populate) |

### Example request

```http
GET /api/priests?filters[tenant][tenantId][$eq]=tenant_mosc_001&populate[0]=diocese&populate[1]=parish&populate[2]=image&sort=name:asc
```

---

## 8. Directory – Entries

Generic directory entries for: institutions, church dignitaries, working committee, managing committee, spiritual organisations, pilgrim centres, seminaries. Differentiated by `directoryType`.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/directory-entries` | List directory entries (tenant-scoped) |
| GET | `/api/directory-entries/:documentId` | Single directory entry by documentId |

### Query parameters (list)

| Parameter | Required | Description |
|-----------|----------|-------------|
| `filters[tenant][tenantId][$eq]` | Yes | Tenant ID |
| `filters[directoryType][$eq]` | No | Filter by type (see enum below) |
| `sort` | No | e.g. `order:asc`, `name:asc` |
| `populate[0]` | No | `image` — entry image |
| `pagination[page]`, `pagination[pageSize]` | No | Pagination |

### Response fields

| Field | Type | Description |
|-------|------|-------------|
| `documentId` | string | Unique document ID |
| `name` | string | Entry name |
| `slug` | string | UID from name (for URLs) |
| `directoryType` | string | Enum: `institutions`, `church-dignitaries`, `working-committee`, `managing-committee`, `spiritual-organisations`, `pilgrim-centres`, `seminaries` |
| `address` | string \| null | Address text |
| `email` | string \| null | Email |
| `phones` | string \| null | Phone number(s), comma-separated if multiple |
| `website` | string \| null | Website URL |
| `description` | string \| null | Optional role or description (e.g. Association Secretary) |
| `image` | object \| null | Image (media) |
| `order` | number | Display order within same directoryType (default 0) |
| `tenant` | object \| null | Tenant relation (optional to populate) |

### directoryType enum values

| Value | Section label (example) |
|-------|-------------------------|
| `institutions` | Institutions |
| `church-dignitaries` | Church Dignitaries |
| `working-committee` | Working Committee |
| `managing-committee` | Managing Committee |
| `spiritual-organisations` | Spiritual Organisations |
| `pilgrim-centres` | Pilgrim Centres |
| `seminaries` | Seminaries |

### Example requests

```http
# All directory entries for a tenant, ordered by type and order
GET /api/directory-entries?filters[tenant][tenantId][$eq]=tenant_mosc_001&sort=directoryType:asc,order:asc&populate[0]=image

# Only pilgrim centres
GET /api/directory-entries?filters[tenant][tenantId][$eq]=tenant_mosc_001&filters[directoryType][$eq]=pilgrim-centres&sort=order:asc&populate[0]=image
```

---

## 9. Quick reference

| Item | Value |
|------|-------|
| Content API base | `http://localhost:1337/api` |
| Tenant filter (all directory) | `filters[tenant][tenantId][$eq]=<tenantId>` |
| Single resource by ID | Use `documentId` in path: `/api/bishops/:documentId` |
| Populate relations | `populate[0]=diocese&populate[1]=image` (or array syntax per main API reference) |

For tenant resolution, auth, and general API behaviour, see `documentation/api_reference.md`.
