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
 *   4. For each article, matches by slug to get the original publishedAt.
 *   5. Sends batches to POST /api/migration/fix-published which directly
 *      updates the published DB rows (bypasses publish flow / lifecycle hooks).
 *
 * Prerequisites:
 *   - Deploy the updated code (with src/api/migration/) to Cloud FIRST.
 *   - Full Access API token on the Cloud instance.
 *   - Set STRAPI_MIGRATION_TOKEN on Cloud to match STRAPI_CLOUD_API_TOKEN
 *     (or the controller falls back to API_TOKEN_SALT).
 *   - Export file: db_backup/my-export-3-prod.tar.gz (or pass path as CLI arg).
 *
 * Usage:
 *   STRAPI_CLOUD_URL=https://YOUR-PROJECT.strapiapp.com \
 *   STRAPI_CLOUD_API_TOKEN=xxx \
 *   node scripts/fix_production_tenant_and_dates.js [path-to-export.tar.gz]
 *
 * Options:
 *   --dry-run        Parse and log only, no HTTP requests.
 *   --tenant-only    Only fix tenant relation, do not touch publishedAt.
 *   --dates-only     Only fix publishedAt, do not touch tenant.
 *   --batch-size=N   Articles per request (default 20).
 *   --content-type=  Content type UID (default: api::article.article).
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
const TENANT_ONLY = args.includes('--tenant-only');
const DATES_ONLY = args.includes('--dates-only');
const ctArg = args.find(a => a.startsWith('--content-type='));
const CONTENT_TYPE_UID = ctArg ? ctArg.split('=')[1] : 'api::article.article';
const bsArg = args.find(a => a.startsWith('--batch-size='));
const BATCH_SIZE = bsArg ? Math.max(1, parseInt(bsArg.split('=')[1], 10)) : 20;

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const TENANT_ID_FILTER = process.env.TENANT_ID || 'tenant_demo_002';
const TRANSFER_DATE_PREFIX = '2026-02-15'; // date when data was transferred

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

async function fetchWithRetry(fn, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
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
    const entities = [];
    const tenantLinks = [];
    const tenants = [];

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
  const byDocId = {};
  for (const e of entities) {
    if (!e.documentId) continue;
    if (!byDocId[e.documentId]) byDocId[e.documentId] = [];
    byDocId[e.documentId].push(e);
  }

  const slugMap = {};
  for (const [docId, rows] of Object.entries(byDocId)) {
    const original = rows.find(r => r.publishedAt && r.publishedAt.indexOf(TRANSFER_DATE_PREFIX) === -1);
    const any = rows.find(r => r.slug);
    const slug = any?.slug;
    if (!slug) continue;

    slugMap[slug] = {
      originalPublishedAt: original?.publishedAt || null,
      documentId: docId,
    };
  }
  return slugMap;
}

// --- Cloud operations ---

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
  console.log(`Batch size: ${BATCH_SIZE}`);
  if (DRY_RUN) console.log('DRY RUN — no HTTP requests will be made.\n');
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
    console.log('\nDry run complete. No changes made.');
    return;
  }

  if (slugCount === 0) {
    console.error('No entities found in export. Check content type UID.');
    process.exit(1);
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

  // Step 4: Match and build migration payload
  console.log(`\nStep 4: Building migration payload...`);
  const migrationItems = [];
  const notMatched = [];

  for (const article of cloudArticles) {
    const slug = article.slug;
    const docId = article.documentId;
    if (!slug || !docId) continue;

    const exportData = slugMap[slug];
    if (!exportData) {
      notMatched.push(slug);
      continue;
    }

    const originalDate = exportData.originalPublishedAt;
    const currentTenant = article.tenant?.documentId || article.tenant?.id;
    const needsDateFix = !TENANT_ONLY && originalDate && article.publishedAt !== originalDate;
    const needsTenantFix = !DATES_ONLY && tenantDocId && currentTenant !== tenantDocId;

    if (!needsDateFix && !needsTenantFix) continue;

    const item = { documentId: docId, uid: CONTENT_TYPE_UID };
    if (needsDateFix) item.publishedAt = originalDate;
    migrationItems.push(item);
  }

  console.log(`  Need to fix: ${migrationItems.length} articles`);
  console.log(`  Already correct: ${cloudArticles.length - migrationItems.length - notMatched.length}`);
  if (notMatched.length > 0) {
    console.log(`  Not matched: ${notMatched.length} slugs`);
  }

  if (migrationItems.length === 0) {
    console.log('\nNothing to fix. All articles are up to date.');
    return;
  }

  // Step 5: Send to migration endpoint in batches
  console.log(`\nStep 5: Sending ${migrationItems.length} articles to migration endpoint (batch size ${BATCH_SIZE})...`);
  let totalUpdated = 0;
  let totalTenantLinked = 0;
  let totalErrors = 0;

  const totalBatches = Math.ceil(migrationItems.length / BATCH_SIZE);
  for (let b = 0; b < totalBatches; b++) {
    const batch = migrationItems.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
    const batchNum = b + 1;

    try {
      const res = await fetchWithRetry(() => apiFetch('/api/migration/fix-published', {
        method: 'POST',
        body: JSON.stringify({
          token: API_TOKEN,
          tenantDocumentId: tenantDocId,
          articles: batch,
        }),
      }), 2);

      const r = res?.results || {};
      totalUpdated += r.updated || 0;
      totalTenantLinked += r.tenantLinked || 0;
      totalErrors += (r.errors || []).length;

      console.log(`  Batch ${batchNum}/${totalBatches}: updated=${r.updated || 0}, tenantLinked=${r.tenantLinked || 0}, skipped=${r.skipped || 0}, errors=${(r.errors || []).length}`);
      if ((r.errors || []).length > 0) {
        r.errors.forEach(e => console.warn(`    Error: ${e.documentId} → ${e.error}`));
      }
    } catch (err) {
      console.error(`  Batch ${batchNum}/${totalBatches} FAILED: ${err.message}`);
      totalErrors += batch.length;
    }

    if (b < totalBatches - 1) await sleep(500);
  }

  // Summary
  console.log('\n=== Summary ===');
  console.log(`Total on Cloud:     ${cloudArticles.length}`);
  console.log(`Dates updated:      ${totalUpdated}`);
  console.log(`Tenant linked:      ${totalTenantLinked}`);
  console.log(`Errors:             ${totalErrors}`);
  if (notMatched.length > 0) {
    console.log(`\nNot matched (${notMatched.length} slugs not in export):`);
    notMatched.slice(0, 20).forEach(s => console.log(`  - ${s}`));
    if (notMatched.length > 20) console.log(`  ... and ${notMatched.length - 20} more`);
  }
  console.log('\nDone. Remove src/api/migration/ after verifying results.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
