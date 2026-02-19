'use strict';

/**
 * One-time migration: fix tenant relation and publishedAt on published articles
 * in production Strapi Cloud.
 *
 * What it does:
 *   1. Reads the Strapi export tar.gz to extract original publishedAt dates
 *      (from draft rows) and builds a slug → originalPublishedAt map.
 *   2. Queries the Cloud for the tenant (tenant_demo_002) documentId.
 *   3. Fetches all articles from Cloud (paginated).
 *   4. For each article:
 *      a. Matches by slug to get the original publishedAt.
 *      b. PUTs to update draft with correct publishedAt + tenant.
 *      c. POSTs to publish (with x-skip-publish-date-refresh header so the
 *         publishDateRefresh middleware does not overwrite the date to NOW).
 *
 * Prerequisites:
 *   - Deploy the updated bootstrap.js (with registerTenantPublishMiddleware and
 *     the x-skip-publish-date-refresh header support) to Cloud FIRST.
 *   - Full Access API token on the Cloud instance.
 *   - Export file: db_backup/my-export-3-prod.tar.gz (or pass path as CLI arg).
 *
 * Usage:
 *   STRAPI_CLOUD_URL=https://YOUR-PROJECT.strapiapp.com \
 *   STRAPI_CLOUD_API_TOKEN=xxx \
 *   node scripts/fix_production_tenant_and_dates.js [path-to-export.tar.gz]
 *
 * Options:
 *   --dry-run        Parse and log only, no HTTP requests.
 *   --skip-publish   Only update drafts, do not publish.
 *   --tenant-only    Only fix tenant relation, do not touch publishedAt.
 *   --dates-only     Only fix publishedAt, do not touch tenant.
 *   --content-type=  Content type UID to fix (default: api::article.article).
 *                    Use --content-type=api::flash-news-item.flash-news-item for flash news.
 */

try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');
const { createGunzip } = require('zlib');
const tarStream = require('tar-stream');

const projectRoot = path.resolve(__dirname, '..');

// --- CLI args and env ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SKIP_PUBLISH = args.includes('--skip-publish');
const TENANT_ONLY = args.includes('--tenant-only');
const DATES_ONLY = args.includes('--dates-only');
const ctArg = args.find(a => a.startsWith('--content-type='));
const CONTENT_TYPE_UID = ctArg ? ctArg.split('=')[1] : 'api::article.article';

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const TENANT_ID_FILTER = process.env.TENANT_ID || 'tenant_demo_002';
const TRANSFER_DATE_PREFIX = '2026-02-15'; // date when data was transferred; used to identify overwritten dates

if (!CLOUD_URL || !API_TOKEN) {
  console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN env vars.');
  process.exit(1);
}

// --- Helpers ---

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function apiFetch(urlPath, options = {}) {
  const url = `${CLOUD_URL}${urlPath}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_TOKEN}`,
      ...options.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${options.method || 'GET'} ${urlPath}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function apiFetchWithRetry(urlPath, options = {}, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await apiFetch(urlPath, options);
    } catch (err) {
      if (attempt < retries) {
        const delay = 2000 * Math.pow(2, attempt);
        console.warn(`  Retry ${attempt + 1}/${retries} in ${delay}ms: ${err.message}`);
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
}

// --- Step 1: Parse export tar.gz ---

function loadPluralName(uid) {
  // e.g. api::article.article -> article -> look up schema
  const parts = uid.split('.');
  const singularName = parts[parts.length - 1];
  const schemaPath = path.join(projectRoot, 'src', 'api', singularName, 'content-types', singularName, 'schema.json');
  if (fs.existsSync(schemaPath)) {
    try {
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
      return schema.info?.pluralName || singularName + 's';
    } catch (_) {}
  }
  return singularName + 's';
}

function parseExport(exportPath, contentTypeUid) {
  return new Promise((resolve, reject) => {
    const entities = []; // { id, documentId, slug, publishedAt, ... }
    const tenantLinks = []; // { entityRef, tenantRef }
    const tenants = []; // { id, documentId, tenantId, name }

    let readStream = fs.createReadStream(exportPath);
    if (exportPath.endsWith('.gz')) {
      readStream = readStream.pipe(createGunzip());
    }
    const extract = tarStream.extract();

    function processJsonl(stream, next, onLine) {
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        const lines = Buffer.concat(chunks).toString().split('\n').filter(Boolean);
        for (const line of lines) {
          try { onLine(JSON.parse(line)); } catch (_) {}
        }
        next();
      });
      stream.resume();
    }

    extract.on('entry', (header, stream, next) => {
      const name = header.name;

      if (name.startsWith('links/') && name.endsWith('.jsonl')) {
        processJsonl(stream, next, (row) => {
          const left = row.left;
          const right = row.right;
          if (!left || !right) return;
          // Article-tenant links
          if (left.type === contentTypeUid && left.field === 'tenant') {
            tenantLinks.push({ entityRef: left.ref, tenantRef: right.ref });
          }
        });
        return;
      }

      if (name.startsWith('entities/') && name.endsWith('.jsonl')) {
        processJsonl(stream, next, (row) => {
          if (row.type === contentTypeUid) {
            entities.push({
              id: row.id,
              documentId: row.data?.documentId,
              slug: row.data?.slug,
              title: row.data?.title,
              publishedAt: row.data?.publishedAt,
              isFeatured: row.data?.isFeatured,
              views: row.data?.views,
            });
          }
          if (row.type === 'api::tenant.tenant') {
            tenants.push({
              id: row.id,
              documentId: row.data?.documentId,
              tenantId: row.data?.tenantId,
              name: row.data?.name,
            });
          }
        });
        return;
      }

      stream.resume();
      next();
    });

    extract.on('finish', () => resolve({ entities, tenantLinks, tenants }));
    extract.on('error', reject);
    readStream.pipe(extract);
  });
}

function buildSlugToOriginalDate(entities) {
  // Group by documentId; pick the row with the original publishedAt (not transfer date, not null)
  const byDocId = {};
  for (const e of entities) {
    if (!e.documentId) continue;
    if (!byDocId[e.documentId]) byDocId[e.documentId] = [];
    byDocId[e.documentId].push(e);
  }

  const slugMap = {}; // slug -> { originalPublishedAt, documentId, isFeatured, views }
  for (const [docId, rows] of Object.entries(byDocId)) {
    // Find the row with the original publishedAt (not transfer date prefix, not null)
    const original = rows.find(r => r.publishedAt && r.publishedAt.indexOf(TRANSFER_DATE_PREFIX) === -1);
    const any = rows.find(r => r.slug);
    const slug = any?.slug;
    if (!slug) continue;

    slugMap[slug] = {
      originalPublishedAt: original?.publishedAt || null,
      documentId: docId,
      isFeatured: rows[0]?.isFeatured,
      views: rows[0]?.views,
    };
  }
  return slugMap;
}

// --- Step 2–4: Cloud operations ---

async function findTenantOnCloud(tenantIdFilter) {
  const res = await apiFetch(`/api/tenants?filters[tenantId][$eq]=${encodeURIComponent(tenantIdFilter)}&pagination[pageSize]=1`);
  const first = Array.isArray(res?.data) ? res.data[0] : res?.data;
  if (!first?.documentId) {
    throw new Error(`Tenant "${tenantIdFilter}" not found on Cloud.`);
  }
  return first.documentId;
}

async function fetchAllArticlesFromCloud(pluralName) {
  const articles = [];
  let page = 1;
  const pageSize = 100;
  while (true) {
    const res = await apiFetch(
      `/api/${pluralName}?pagination[page]=${page}&pagination[pageSize]=${pageSize}&populate=tenant&status=published`
    );
    const data = Array.isArray(res?.data) ? res.data : [];
    articles.push(...data);
    const pagination = res?.meta?.pagination;
    if (!pagination || page >= pagination.pageCount) break;
    page++;
  }
  return articles;
}

async function main() {
  const exportPath = args.find(a => !a.startsWith('--'))
    || path.join(projectRoot, 'db_backup', 'my-export-3-prod.tar.gz');

  if (!fs.existsSync(exportPath)) {
    console.error('Export file not found:', exportPath);
    process.exit(1);
  }

  const pluralName = loadPluralName(CONTENT_TYPE_UID);
  console.log(`Content type: ${CONTENT_TYPE_UID} (${pluralName})`);
  console.log('Export file:', exportPath);
  console.log('Cloud URL:', CLOUD_URL);
  if (DRY_RUN) console.log('DRY RUN — no HTTP requests will be made.\n');
  if (SKIP_PUBLISH) console.log('SKIP PUBLISH — drafts will be updated but not published.\n');
  if (TENANT_ONLY) console.log('TENANT ONLY — only fixing tenant relation.\n');
  if (DATES_ONLY) console.log('DATES ONLY — only fixing publishedAt.\n');

  // Step 1: Parse export
  console.log('\nStep 1: Parsing export...');
  const { entities, tenantLinks, tenants } = await parseExport(exportPath, CONTENT_TYPE_UID);
  console.log(`  Entities: ${entities.length} rows`);
  console.log(`  Tenant links: ${tenantLinks.length}`);
  console.log(`  Tenants: ${tenants.map(t => `${t.tenantId} (id=${t.id})`).join(', ')}`);

  const slugMap = buildSlugToOriginalDate(entities);
  const slugCount = Object.keys(slugMap).length;
  const withDates = Object.values(slugMap).filter(v => v.originalPublishedAt).length;
  console.log(`  Unique slugs: ${slugCount}, with original dates: ${withDates}`);

  if (DRY_RUN) {
    console.log('\nSample slug map (first 10):');
    Object.entries(slugMap).slice(0, 10).forEach(([slug, data]) => {
      console.log(`  ${slug} → ${data.originalPublishedAt || '(no date)'}`);
    });
  }

  if (slugCount === 0) {
    console.error('No entities found in export. Check content type UID.');
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log('\nDry run complete. No changes made.');
    return;
  }

  // Step 2: Find tenant on Cloud
  let tenantDocId = null;
  if (!DATES_ONLY) {
    console.log(`\nStep 2: Finding tenant "${TENANT_ID_FILTER}" on Cloud...`);
    tenantDocId = await findTenantOnCloud(TENANT_ID_FILTER);
    console.log(`  Tenant documentId: ${tenantDocId}`);
  }

  // Step 3: Fetch all articles from Cloud
  console.log(`\nStep 3: Fetching all ${pluralName} from Cloud...`);
  const cloudArticles = await fetchAllArticlesFromCloud(pluralName);
  console.log(`  Found ${cloudArticles.length} published ${pluralName} on Cloud.`);

  // Step 4: Update each article
  console.log(`\nStep 4: Updating ${pluralName}...`);
  let updated = 0;
  let published = 0;
  let skipped = 0;
  let errors = 0;
  const notMatched = [];

  for (let i = 0; i < cloudArticles.length; i++) {
    const article = cloudArticles[i];
    const slug = article.slug;
    const docId = article.documentId;

    if (!slug || !docId) {
      skipped++;
      continue;
    }

    const exportData = slugMap[slug];
    if (!exportData) {
      notMatched.push(slug);
      skipped++;
      continue;
    }

    const originalDate = exportData.originalPublishedAt;
    const currentTenant = article.tenant?.documentId || article.tenant?.id;
    const needsDateFix = !TENANT_ONLY && originalDate && article.publishedAt !== originalDate;
    const needsTenantFix = !DATES_ONLY && tenantDocId && currentTenant !== tenantDocId;

    if (!needsDateFix && !needsTenantFix) {
      skipped++;
      continue;
    }

    // Build update payload
    const data = {};
    if (needsDateFix) {
      data.publishedAt = originalDate;
    }
    if (needsTenantFix) {
      data.tenant = { connect: [{ documentId: tenantDocId }] };
    }

    const label = `[${i + 1}/${cloudArticles.length}] ${slug.slice(0, 50)}`;

    try {
      // PUT to update draft
      await apiFetchWithRetry(`/api/${pluralName}/${docId}`, {
        method: 'PUT',
        body: JSON.stringify({ data }),
      });
      updated++;

      // Publish (with skip header so publishDateRefresh doesn't overwrite the date)
      if (!SKIP_PUBLISH) {
        await apiFetchWithRetry(`/api/${pluralName}/${docId}/actions/publish`, {
          method: 'POST',
          body: JSON.stringify({}),
          headers: {
            'x-skip-publish-date-refresh': '1',
          },
        });
        published++;
      }

      const changes = [];
      if (needsDateFix) changes.push(`date→${originalDate.slice(0, 10)}`);
      if (needsTenantFix) changes.push(`tenant→${TENANT_ID_FILTER}`);
      console.log(`  ✓ ${label} (${changes.join(', ')})`);
    } catch (err) {
      console.error(`  ✖ ${label}: ${err.message}`);
      errors++;
    }

    // Small delay to avoid rate limiting
    if (i < cloudArticles.length - 1) await sleep(200);
  }

  // Summary
  console.log('\n=== Summary ===');
  console.log(`Total on Cloud: ${cloudArticles.length}`);
  console.log(`Updated:        ${updated}`);
  console.log(`Published:      ${published}`);
  console.log(`Skipped:        ${skipped} (already correct or no match)`);
  console.log(`Errors:         ${errors}`);
  if (notMatched.length > 0) {
    console.log(`\nNot matched (${notMatched.length} slugs not in export):`);
    notMatched.slice(0, 20).forEach(s => console.log(`  - ${s}`));
    if (notMatched.length > 20) console.log(`  ... and ${notMatched.length - 20} more`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
