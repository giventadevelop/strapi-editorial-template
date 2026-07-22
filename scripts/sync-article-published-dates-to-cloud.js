'use strict';
/**
 * Sync article publishedAt from local Strapi to Cloud by slug (production tenant).
 * Uses POST /api/migration/fix-published so publish lifecycle does not overwrite dates.
 *
 * Usage:
 *   node scripts/sync-article-published-dates-to-cloud.js --tenant-id=mosc_malankara_orthodox_2
 *   node scripts/sync-article-published-dates-to-cloud.js --tenant-id=mosc_malankara_orthodox_2 --dry-run
 */
try {
  require('dotenv').config();
} catch (_) {}

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';

function getArg(name, fallback = null) {
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === `--${name}` && process.argv[i + 1]) return process.argv[i + 1].trim();
    const m = a.match(new RegExp(`^--${name}=(.+)$`));
    if (m) return m[1].trim();
  }
  return fallback;
}

const TENANT_ID = getArg('tenant-id', process.env.TENANT_ID || 'mosc_malankara_orthodox_2');
const DRY_RUN = process.argv.includes('--dry-run');
const BATCH = Math.max(1, parseInt(getArg('batch-size', '25'), 10) || 25);

async function cloudFetch(pathname, options = {}) {
  const res = await fetch(`${CLOUD_URL}${pathname}`, {
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
    json = { raw: text.slice(0, 300) };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}: ${text.slice(0, 300)}`);
  return json;
}

async function main() {
  if (!CLOUD_URL || !API_TOKEN) {
    console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN');
    process.exit(1);
  }

  const tenants = await cloudFetch(
    `/api/tenants?filters[tenantId][$eq]=${encodeURIComponent(TENANT_ID)}&pagination[pageSize]=1`
  );
  const tenantDocumentId = tenants.data?.[0]?.documentId;
  if (!tenantDocumentId) {
    console.error('Cloud tenant not found:', TENANT_ID);
    process.exit(1);
  }

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const app = await createStrapi(await compileStrapi()).load();
  app.log.level = 'error';

  let localArticles = [];
  try {
    localArticles = await app.documents('api::article.article').findMany({
      filters: { tenant: { tenantId: { $eq: TENANT_ID } } },
      status: 'published',
      fields: ['slug', 'publishedAt', 'title'],
      pagination: { pageSize: 500 },
    });
  } finally {
    await app.destroy();
  }

  const withDates = localArticles.filter((a) => a.slug && a.publishedAt);
  console.log('Local published articles with dates:', withDates.length);
  console.log('Cloud tenantDocumentId:', tenantDocumentId);
  if (DRY_RUN) {
    for (const a of withDates.slice(0, 5)) {
      console.log('  sample', a.slug, a.publishedAt);
    }
    process.exit(0);
  }

  // Fetch Cloud documentIds by slug (tenant-filtered first; then -mo2 slug fallback)
  const cloudBySlug = new Map();
  async function loadCloudArticles(extraParams) {
    let page = 1;
    while (true) {
      const qs = new URLSearchParams({
        'pagination[page]': String(page),
        'pagination[pageSize]': '100',
        'fields[0]': 'slug',
        'fields[1]': 'publishedAt',
        ...extraParams,
      });
      const data = await cloudFetch(`/api/articles?${qs}`);
      const rows = data.data || [];
      if (!rows.length) break;
      for (const row of rows) {
        if (row.slug) cloudBySlug.set(row.slug, row);
      }
      if (page >= (data.meta?.pagination?.pageCount || 1)) break;
      page++;
    }
  }
  await loadCloudArticles({ 'filters[tenant][tenantId][$eq]': TENANT_ID });
  if (cloudBySlug.size === 0) {
    console.warn('Tenant filter returned 0 articles; falling back to slug contains -mo2');
    await loadCloudArticles({ 'filters[slug][$containsi]': '-mo2' });
  }
  console.log('Cloud articles indexed by slug:', cloudBySlug.size);

  const payload = [];
  let mismatch = 0;
  for (const local of withDates) {
    const cloud = cloudBySlug.get(local.slug);
    if (!cloud?.documentId) continue;
    const localIso = new Date(local.publishedAt).toISOString();
    const cloudIso = cloud.publishedAt ? new Date(cloud.publishedAt).toISOString() : null;
    if (cloudIso !== localIso) mismatch++;
    payload.push({
      documentId: cloud.documentId,
      uid: 'api::article.article',
      publishedAt: localIso,
    });
  }
  console.log('Matched on Cloud:', payload.length, 'date mismatches:', mismatch);

  let updated = 0;
  let errors = 0;
  for (let i = 0; i < payload.length; i += BATCH) {
    const batch = payload.slice(i, i + BATCH);
    const res = await cloudFetch('/api/migration/fix-published', {
      method: 'POST',
      body: JSON.stringify({
        tenantDocumentId,
        articles: batch,
      }),
    });
    updated += res?.results?.updated || 0;
    errors += (res?.results?.errors || []).length;
    console.log(`Batch ${Math.floor(i / BATCH) + 1}: updated=${res?.results?.updated} errors=${(res?.results?.errors || []).length}`);
  }

  console.log('Done. updated=', updated, 'errors=', errors);

  // Verify a few
  const qs = new URLSearchParams({
    'filters[tenant][tenantId][$eq]': TENANT_ID,
    'filters[category][slug][$eq]': 'main-news',
    'filters[publishedAt][$notNull]': 'true',
    sort: 'publishedAt:desc',
    'pagination[pageSize]': '5',
    'fields[0]': 'slug',
    'fields[1]': 'publishedAt',
    'fields[2]': 'title',
  });
  const verify = await cloudFetch(`/api/articles?${qs}`);
  console.log('Verify main-news (newest by publishedAt):');
  for (const a of verify.data || []) {
    console.log(' ', a.publishedAt, a.slug, String(a.title || '').slice(0, 40));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
