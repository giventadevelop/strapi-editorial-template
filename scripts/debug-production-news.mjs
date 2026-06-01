#!/usr/bin/env node

/**
 * Read-only production debug for MOSC news queries.
 *
 * Usage:
 *   node scripts/debug-production-news.mjs
 *
 * Env (required):
 *   STRAPI_CLOUD_URL        (or STRAPI_PRODUCTION_URL / STRAPI_URL)
 *   STRAPI_CLOUD_API_TOKEN  (or STRAPI_PRODUCTION_API_TOKEN / STRAPI_API_TOKEN)
 */

import 'dotenv/config';

const BASE_URL = (
  process.env.STRAPI_CLOUD_URL ||
  process.env.STRAPI_PRODUCTION_URL ||
  process.env.STRAPI_URL ||
  ''
).replace(/\/$/, '');

const API_TOKEN =
  process.env.STRAPI_CLOUD_API_TOKEN ||
  process.env.STRAPI_PRODUCTION_API_TOKEN ||
  process.env.STRAPI_API_TOKEN ||
  '';

const TARGET_TENANT_ID = process.env.TENANT_ID || 'tenant_demo_002';

if (!BASE_URL || !API_TOKEN) {
  console.error('Missing env. Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN.');
  process.exit(1);
}

function extractRows(json) {
  if (!json) return [];
  if (Array.isArray(json.data)) return json.data;
  if (json.data && typeof json.data === 'object') return [json.data];
  if (Array.isArray(json)) return json;
  return [];
}

function f(row, key) {
  if (!row || typeof row !== 'object') return null;
  if (row[key] != null) return row[key];
  if (row.attributes && row.attributes[key] != null) return row.attributes[key];
  return null;
}

function relationObj(row, relationName) {
  const direct = row?.[relationName];
  const attr = row?.attributes?.[relationName];
  const rel = direct ?? attr;
  if (!rel) return null;
  if (rel.data) return rel.data;
  return rel;
}

function summarizeTenantShape(row) {
  const t = relationObj(row, 'tenant');
  if (!t) return 'tenant:missing';

  const d = Array.isArray(t) ? t[0] : t;
  if (!d) return 'tenant:present-empty';

  const tenantId = f(d, 'tenantId');
  const tenant_id = f(d, 'tenant_id');
  const documentId = f(d, 'documentId');
  const id = f(d, 'id');

  const parts = [];
  if (id != null) parts.push(`id=${id}`);
  if (documentId) parts.push(`documentId=${documentId}`);
  if (tenantId) parts.push(`tenantId=${tenantId}`);
  if (tenant_id) parts.push(`tenant_id=${tenant_id}`);
  return parts.length ? `tenant:${parts.join(',')}` : 'tenant:present-no-known-fields';
}

function summarizeArticle(row) {
  return {
    id: f(row, 'id'),
    documentId: f(row, 'documentId'),
    title: f(row, 'title'),
    slug: f(row, 'slug'),
    publishedAt: f(row, 'publishedAt'),
    tenantShape: summarizeTenantShape(row),
  };
}

async function apiGet(path) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    json = { raw: text?.slice(0, 500) };
  }
  return { status: res.status, json };
}

function printResult(name, path, result, isArticle = false) {
  const rows = extractRows(result.json);
  console.log(`\n[${name}]`);
  console.log(`GET ${path}`);
  console.log(`status=${result.status}, rows=${rows.length}`);
  const preview = rows
    .slice(0, 3)
    .map((r) => (isArticle ? summarizeArticle(r) : {
      id: f(r, 'id'),
      documentId: f(r, 'documentId'),
      tenantId: f(r, 'tenantId'),
      tenant_id: f(r, 'tenant_id'),
      name: f(r, 'name'),
    }));
  console.log(JSON.stringify(preview, null, 2));
  return rows;
}

function topCount(result) {
  return extractRows(result?.json).length;
}

async function main() {
  console.log('Production news debug (read-only)');
  console.log(`baseUrl=${BASE_URL}`);
  console.log(`tenantId=${TARGET_TENANT_ID}`);

  const checks = {};

  checks.a = await apiGet(
    `/api/tenants?filters[tenantId][$eq]=${encodeURIComponent(TARGET_TENANT_ID)}&pagination[pageSize]=5`
  );
  const tenantRowsA = printResult(
    'a) tenants by tenantId',
    `/api/tenants?filters[tenantId][$eq]=${TARGET_TENANT_ID}&pagination[pageSize]=5`,
    checks.a
  );

  checks.b = await apiGet(
    `/api/tenants?filters[tenant_id][$eq]=${encodeURIComponent(TARGET_TENANT_ID)}&pagination[pageSize]=5`
  );
  printResult(
    'b) tenants by tenant_id',
    `/api/tenants?filters[tenant_id][$eq]=${TARGET_TENANT_ID}&pagination[pageSize]=5`,
    checks.b
  );

  const tenantDocumentId =
    f(tenantRowsA[0], 'documentId') ||
    f(extractRows(checks.b.json)[0], 'documentId') ||
    '';

  checks.c = await apiGet(
    '/api/articles?filters[publishedAt][$notNull]=true&pagination[page]=1&pagination[pageSize]=5'
  );
  printResult(
    'c) articles published',
    '/api/articles?filters[publishedAt][$notNull]=true&pagination[page]=1&pagination[pageSize]=5',
    checks.c,
    true
  );

  checks.d = await apiGet(
    `/api/articles?filters[tenant][tenantId][$eq]=${encodeURIComponent(TARGET_TENANT_ID)}&filters[publishedAt][$notNull]=true&pagination[page]=1&pagination[pageSize]=5`
  );
  printResult(
    'd) articles by tenant.tenantId',
    `/api/articles?filters[tenant][tenantId][$eq]=${TARGET_TENANT_ID}&filters[publishedAt][$notNull]=true&pagination[page]=1&pagination[pageSize]=5`,
    checks.d,
    true
  );

  if (tenantDocumentId) {
    checks.e = await apiGet(
      `/api/articles?filters[tenant][documentId][$eq]=${encodeURIComponent(tenantDocumentId)}&filters[publishedAt][$notNull]=true&pagination[page]=1&pagination[pageSize]=5`
    );
    printResult(
      'e) articles by tenant.documentId',
      `/api/articles?filters[tenant][documentId][$eq]=${tenantDocumentId}&filters[publishedAt][$notNull]=true&pagination[page]=1&pagination[pageSize]=5`,
      checks.e,
      true
    );

    checks.f = await apiGet(
      `/api/articles?filters[$or][0][tenant][tenantId][$eq]=${encodeURIComponent(TARGET_TENANT_ID)}&filters[$or][1][tenant][documentId][$eq]=${encodeURIComponent(tenantDocumentId)}&filters[publishedAt][$notNull]=true&pagination[page]=1&pagination[pageSize]=5`
    );
    printResult(
      'f) articles OR filter (tenantId OR documentId)',
      `/api/articles?filters[$or][0][tenant][tenantId][$eq]=${TARGET_TENANT_ID}&filters[$or][1][tenant][documentId][$eq]=${tenantDocumentId}&filters[publishedAt][$notNull]=true&pagination[page]=1&pagination[pageSize]=5`,
      checks.f,
      true
    );
  } else {
    console.log('\n[e/f] skipped: no tenantDocumentId found from tenant queries.');
  }

  const categorySlugs = ['featured-news', 'main-news', 'press-release'];
  checks.g = {};
  for (const slug of categorySlugs) {
    const path =
      tenantDocumentId
        ? `/api/articles?filters[$or][0][tenant][tenantId][$eq]=${encodeURIComponent(TARGET_TENANT_ID)}&filters[$or][1][tenant][documentId][$eq]=${encodeURIComponent(tenantDocumentId)}&filters[category][slug][$eq]=${encodeURIComponent(slug)}&filters[publishedAt][$notNull]=true&pagination[page]=1&pagination[pageSize]=5`
        : `/api/articles?filters[tenant][tenantId][$eq]=${encodeURIComponent(TARGET_TENANT_ID)}&filters[category][slug][$eq]=${encodeURIComponent(slug)}&filters[publishedAt][$notNull]=true&pagination[page]=1&pagination[pageSize]=5`;
    const result = await apiGet(path);
    checks.g[slug] = result;
    printResult(`g) category=${slug}`, path, result, true);
  }

  checks.h = await apiGet('/api/categories?pagination[page]=1&pagination[pageSize]=50');
  const categoryRows = printResult(
    'h) categories list',
    '/api/categories?pagination[page]=1&pagination[pageSize]=50',
    checks.h
  );

  const strategyCounts = {
    'tenant-primary (d)': topCount(checks.d),
    'tenant-documentId (e)': checks.e ? topCount(checks.e) : -1,
    'tenant OR fallback (f)': checks.f ? topCount(checks.f) : -1,
    'no-tenant (c)': topCount(checks.c),
  };

  const best = Object.entries(strategyCounts)
    .filter(([, v]) => v >= 0)
    .sort((a, b) => b[1] - a[1])[0];

  const tenantShapes = extractRows(checks.c.json).slice(0, 3).map(summarizeTenantShape);
  const tenantMissingInPreview = tenantShapes.every((s) => s === 'tenant:missing');
  const zeroCategorySlugs = Object.entries(checks.g)
    .filter(([, r]) => topCount(r) === 0)
    .map(([slug]) => slug);
  const availableCategorySlugs = categoryRows.map((r) => String(f(r, 'slug') || '')).filter(Boolean);
  const availableCategorySlugsLower = new Set(availableCategorySlugs.map((s) => s.toLowerCase()));
  const likelyCaseMismatch = zeroCategorySlugs.filter((s) => availableCategorySlugsLower.has(s.toLowerCase()));

  console.log('\n=== FINAL DIAGNOSIS ===');
  console.log(`Tenant query tenantId(a) rows: ${topCount(checks.a)}`);
  console.log(`Tenant query tenant_id(b) rows: ${topCount(checks.b)}`);
  console.log(`Resolved tenantDocumentId: ${tenantDocumentId || '(not found)'}`);
  console.log(`Best data strategy: ${best ? `${best[0]} -> ${best[1]} rows` : 'none'}`);
  console.log(`Tenant relation in sample rows: ${tenantShapes.join(' | ')}`);
  if (tenantMissingInPreview) {
    console.log('Tenant relation appears missing in sampled article payload (likely not populated or null links).');
  }
  if (zeroCategorySlugs.length > 0) {
    console.log(`Expected category slugs returning 0 rows: ${zeroCategorySlugs.join(', ')}`);
  } else {
    console.log('All expected category slugs returned rows in this sample.');
  }
  if (availableCategorySlugs.length > 0) {
    console.log(`Available category slugs in production: ${availableCategorySlugs.join(', ')}`);
  }

  const recommendation = [];
  if (strategyCounts['tenant OR fallback (f)'] > 0) {
    recommendation.push('Use OR tenant filter (tenantId OR tenant.documentId) as primary frontend query.');
  } else if (strategyCounts['tenant-primary (d)'] > 0) {
    recommendation.push('Use tenant.tenantId filter as primary frontend query.');
  } else if (strategyCounts['tenant-documentId (e)'] > 0) {
    recommendation.push('Use tenant.documentId filter as primary frontend query.');
  } else if (strategyCounts['no-tenant (c)'] > 0) {
    recommendation.push('Only no-tenant query returns data: production tenant links are missing or inconsistent on articles.');
  } else {
    recommendation.push('No published articles returned by any strategy: verify publishedAt and content availability in production.');
  }

  if (zeroCategorySlugs.length > 0) {
    recommendation.push('Verify category slugs in production and ensure articles are linked to those categories.');
  }
  if (likelyCaseMismatch.length > 0) {
    recommendation.push(`Category slug case mismatch likely: use production slugs exactly as stored (e.g. ${availableCategorySlugs.join(', ')}).`);
  }
  if (!tenantDocumentId) {
    recommendation.push('Fix tenant record lookup first (tenantId field mismatch or tenant missing in production).');
  }

  console.log('Recommendation:');
  for (const line of recommendation) {
    console.log(`- ${line}`);
  }
}

main().catch((err) => {
  console.error('Debug script failed:', err?.message || err);
  process.exit(1);
});

