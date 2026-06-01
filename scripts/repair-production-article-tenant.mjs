#!/usr/bin/env node

/**
 * Repair article -> tenant relation on production Strapi (draft + published).
 *
 * Usage:
 *   node scripts/repair-production-article-tenant.mjs --tenant-id=tenant_demo_002
 *   node scripts/repair-production-article-tenant.mjs --tenant-id=tenant_demo_002 --dry-run
 *
 * Env:
 *   STRAPI_CLOUD_URL
 *   STRAPI_CLOUD_API_TOKEN
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
const DRY_RUN = process.argv.includes('--dry-run');
const PAGE_SIZE = Math.max(1, Number(arg('page-size', '100')) || 100);

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

function getField(obj, k) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj[k] != null) return obj[k];
  if (obj.attributes && obj.attributes[k] != null) return obj.attributes[k];
  return null;
}

function tenantFromArticle(article) {
  const t = article?.tenant ?? article?.attributes?.tenant ?? null;
  if (!t) return null;
  const rel = t.data ?? t;
  if (Array.isArray(rel)) return rel[0] || null;
  return rel || null;
}

async function getTenantDocumentId(tenantId) {
  const byTenantId = await api(
    `/api/tenants?filters[tenantId][$eq]=${encodeURIComponent(tenantId)}&pagination[pageSize]=1`
  );
  if (!byTenantId.ok) {
    throw new Error(`Tenant lookup failed by tenantId: HTTP ${byTenantId.status}`);
  }
  const r = rows(byTenantId.json)[0];
  if (r) return getField(r, 'documentId');

  const bySnake = await api(
    `/api/tenants?filters[tenant_id][$eq]=${encodeURIComponent(tenantId)}&pagination[pageSize]=1`
  );
  if (!bySnake.ok) {
    return null;
  }
  return getField(rows(bySnake.json)[0], 'documentId');
}

async function fetchAllArticleDocs() {
  const docs = new Map(); // documentId -> { documentId, draftId?, publishedId?, sampleTitle?, tenantShape? }

  for (const status of ['draft', 'published']) {
    let page = 1;
    while (true) {
      const path = `/api/articles?status=${status}&pagination[page]=${page}&pagination[pageSize]=${PAGE_SIZE}&populate=tenant`;
      const res = await api(path);
      if (!res.ok) {
        throw new Error(`List articles failed status=${status} page=${page} HTTP ${res.status}`);
      }
      const list = rows(res.json);
      for (const a of list) {
        const documentId = getField(a, 'documentId');
        if (!documentId) continue;
        const cur = docs.get(documentId) || { documentId };
        if (status === 'draft') cur.draftId = getField(a, 'id');
        if (status === 'published') cur.publishedId = getField(a, 'id');
        cur.sampleTitle = cur.sampleTitle || getField(a, 'title');
        const t = tenantFromArticle(a);
        cur.tenantShape = t
          ? {
              id: getField(t, 'id'),
              documentId: getField(t, 'documentId'),
              tenantId: getField(t, 'tenantId'),
              tenant_id: getField(t, 'tenant_id'),
            }
          : null;
        docs.set(documentId, cur);
      }

      const pagination = res.json?.meta?.pagination;
      if (!pagination || page >= pagination.pageCount) break;
      page++;
    }
  }

  return [...docs.values()];
}

async function updateArticleTenant(documentId, tenantDocumentId, status) {
  const path = `/api/articles/${encodeURIComponent(documentId)}?status=${status}`;
  const body = {
    data: {
      tenant: tenantDocumentId,
    },
  };
  return api(path, { method: 'PUT', body: JSON.stringify(body) });
}

async function main() {
  console.log('Repair article -> tenant relation (production)');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Target tenantId: ${TENANT_ID}`);
  if (DRY_RUN) console.log('DRY RUN enabled (no updates).');

  const tenantDocumentId = await getTenantDocumentId(TENANT_ID);
  if (!tenantDocumentId) {
    throw new Error(`Tenant not found for tenantId=${TENANT_ID}`);
  }
  console.log(`Resolved tenant documentId: ${tenantDocumentId}`);

  const docs = await fetchAllArticleDocs();
  console.log(`Found article documents (draft+published union): ${docs.length}`);

  const needingUpdate = docs.filter((d) => {
    const relDocId = d.tenantShape?.documentId || null;
    return relDocId !== tenantDocumentId;
  });
  console.log(`Documents needing tenant update: ${needingUpdate.length}`);

  let updatedDraftOk = 0;
  let updatedPublishedOk = 0;
  let failed = 0;

  for (const d of needingUpdate) {
    if (DRY_RUN) continue;
    // Update both variants to enforce relation on all rows
    const draftRes = await updateArticleTenant(d.documentId, tenantDocumentId, 'draft');
    if (draftRes.ok) updatedDraftOk++;
    else failed++;

    const pubRes = await updateArticleTenant(d.documentId, tenantDocumentId, 'published');
    if (pubRes.ok) updatedPublishedOk++;
    else {
      // some docs may not have published variant; don't count as hard failure if 404
      if (pubRes.status !== 404) failed++;
    }
  }

  // Verify by filter query
  const verify = await api(
    `/api/articles?filters[tenant][tenantId][$eq]=${encodeURIComponent(TENANT_ID)}&filters[publishedAt][$notNull]=true&pagination[page]=1&pagination[pageSize]=5`
  );
  const verifyRows = rows(verify.json);

  console.log('\n=== SUMMARY ===');
  console.log(`Tenant documentId: ${tenantDocumentId}`);
  console.log(`Total article docs: ${docs.length}`);
  console.log(`Needed update: ${needingUpdate.length}`);
  console.log(`Updated draft OK: ${updatedDraftOk}`);
  console.log(`Updated published OK: ${updatedPublishedOk}`);
  console.log(`Failures: ${failed}`);
  console.log(`Verify tenant filter status: ${verify.status}, rows=${verifyRows.length}`);
  console.log(
    JSON.stringify(
      verifyRows.slice(0, 3).map((x) => ({
        id: getField(x, 'id'),
        documentId: getField(x, 'documentId'),
        title: getField(x, 'title'),
        slug: getField(x, 'slug'),
        publishedAt: getField(x, 'publishedAt'),
        tenant: tenantFromArticle(x),
      })),
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error('Repair failed:', e?.message || e);
  process.exit(1);
});

