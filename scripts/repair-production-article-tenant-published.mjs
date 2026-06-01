#!/usr/bin/env node

/**
 * Backfill article->tenant relation on PUBLISHED rows via /api/migration/fix-published.
 *
 * Usage:
 *   node scripts/repair-production-article-tenant-published.mjs --tenant-id=tenant_demo_002
 *   node scripts/repair-production-article-tenant-published.mjs --tenant-id=tenant_demo_002 --dry-run
 */

import 'dotenv/config';

const BASE_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';

function arg(name, fallback = null) {
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === `--${name}` && process.argv[i + 1]) return process.argv[i + 1].trim();
    const m = a.match(new RegExp(`^--${name}=(.+)$`));
    if (m) return m[1].trim();
  }
  return fallback;
}

const TENANT_ID = arg('tenant-id', process.env.TENANT_ID || 'tenant_demo_002');
const BATCH_SIZE = Math.max(1, Number(arg('batch-size', '20')) || 20);
const DRY_RUN = process.argv.includes('--dry-run');

if (!BASE_URL || !API_TOKEN) {
  console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN.');
  process.exit(1);
}

async function api(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text?.slice(0, 500) };
  }
  return { status: res.status, ok: res.ok, json };
}

function rows(json) {
  if (!json) return [];
  if (Array.isArray(json.data)) return json.data;
  if (json.data && typeof json.data === 'object') return [json.data];
  return [];
}

function field(obj, k) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj[k] != null) return obj[k];
  if (obj.attributes && obj.attributes[k] != null) return obj.attributes[k];
  return null;
}

async function tenantDocumentId(tenantId) {
  const r = await api(`/api/tenants?filters[tenantId][$eq]=${encodeURIComponent(tenantId)}&pagination[pageSize]=1`);
  if (!r.ok) throw new Error(`Tenant query failed HTTP ${r.status}`);
  const t = rows(r.json)[0];
  return field(t, 'documentId');
}

async function allArticleDocumentIds() {
  const out = new Set();
  let page = 1;
  while (true) {
    const r = await api(`/api/articles?status=draft&pagination[page]=${page}&pagination[pageSize]=100`);
    if (!r.ok) throw new Error(`Article list failed page=${page} HTTP ${r.status}`);
    const list = rows(r.json);
    for (const a of list) {
      const d = field(a, 'documentId');
      if (d) out.add(d);
    }
    const pagination = r.json?.meta?.pagination;
    if (!pagination || page >= pagination.pageCount) break;
    page++;
  }
  return [...out];
}

async function main() {
  console.log('Backfill published article tenant relation');
  console.log(`baseUrl=${BASE_URL}`);
  console.log(`tenantId=${TENANT_ID}`);
  if (DRY_RUN) console.log('DRY RUN enabled.');

  const tenantDoc = await tenantDocumentId(TENANT_ID);
  if (!tenantDoc) throw new Error(`Tenant not found for ${TENANT_ID}`);
  console.log(`tenantDocumentId=${tenantDoc}`);

  const docs = await allArticleDocumentIds();
  console.log(`article documentIds=${docs.length}`);

  const articles = docs.map((documentId) => ({ documentId, uid: 'api::article.article' }));
  if (DRY_RUN) {
    console.log(`Would send ${articles.length} docs to /api/migration/fix-published`);
    process.exit(0);
  }

  let totalUpdated = 0;
  let totalLinked = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);
    const r = await api('/api/migration/fix-published', {
      method: 'POST',
      body: JSON.stringify({
        tenantDocumentId: tenantDoc,
        articles: batch,
      }),
    });
    if (!r.ok) {
      console.error(`Batch ${Math.floor(i / BATCH_SIZE) + 1} failed HTTP ${r.status}`, r.json);
      totalErrors += batch.length;
      continue;
    }
    const res = r.json?.results || {};
    totalUpdated += Number(res.updated || 0);
    totalLinked += Number(res.tenantLinked || 0);
    totalSkipped += Number(res.skipped || 0);
    totalErrors += Array.isArray(res.errors) ? res.errors.length : 0;
    console.log(
      `batch ${Math.floor(i / BATCH_SIZE) + 1}: linked=${res.tenantLinked || 0}, updated=${res.updated || 0}, skipped=${res.skipped || 0}, errors=${Array.isArray(res.errors) ? res.errors.length : 0}`
    );
  }

  const verify = await api(
    `/api/articles?filters[tenant][tenantId][$eq]=${encodeURIComponent(TENANT_ID)}&filters[publishedAt][$notNull]=true&pagination[page]=1&pagination[pageSize]=5`
  );
  const verifyRows = rows(verify.json);

  console.log('\n=== SUMMARY ===');
  console.log(`tenantLinked=${totalLinked}, updated=${totalUpdated}, skipped=${totalSkipped}, errors=${totalErrors}`);
  console.log(`verify status=${verify.status}, rows=${verifyRows.length}`);
  console.log(
    JSON.stringify(
      verifyRows.slice(0, 3).map((x) => ({
        id: field(x, 'id'),
        documentId: field(x, 'documentId'),
        title: field(x, 'title'),
        slug: field(x, 'slug'),
        publishedAt: field(x, 'publishedAt'),
      })),
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error('Backfill failed:', e?.message || e);
  process.exit(1);
});

