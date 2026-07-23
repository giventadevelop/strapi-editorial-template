'use strict';
/**
 * Delete Cloud saint-entries for a tenant whose slug is not present locally.
 * Avoids duplicates / leftover unwanted Cloud rows after a local-source-of-truth sync.
 *
 * Usage:
 *   node scripts/prune-cloud-saints-not-in-local.js --tenant-id=mosc_malankara_orthodox_2
 *   node scripts/prune-cloud-saints-not-in-local.js --tenant-id=mosc_malankara_orthodox_2 --dry-run
 */
try {
  require('dotenv').config();
} catch (_) {}

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const DRY_RUN = process.argv.includes('--dry-run');

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
  if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function main() {
  if (!CLOUD_URL || !API_TOKEN) {
    console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN');
    process.exit(1);
  }

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const app = await createStrapi(await compileStrapi()).load();
  app.log.level = 'error';
  let localSlugs = new Set();
  try {
    const local = await app.documents('api::saint-entry.saint-entry').findMany({
      filters: { tenant: { tenantId: { $eq: TENANT_ID } } },
      fields: ['slug'],
      pagination: { pageSize: 500 },
    });
    localSlugs = new Set((local || []).map((r) => r.slug).filter(Boolean));
  } finally {
    await app.destroy();
  }

  const cloudRows = [];
  let page = 1;
  while (true) {
    const qs = new URLSearchParams({
      'pagination[page]': String(page),
      'pagination[pageSize]': '100',
      'filters[tenant][tenantId][$eq]': TENANT_ID,
      'fields[0]': 'slug',
      'fields[1]': 'name',
    });
    const data = await cloudFetch(`/api/saint-entries?${qs}`);
    const rows = data.data || [];
    if (!rows.length) break;
    cloudRows.push(...rows);
    if (page >= (data.meta?.pagination?.pageCount || 1)) break;
    page++;
  }

  const orphans = cloudRows.filter((r) => r.slug && !localSlugs.has(r.slug));
  console.log('Tenant:', TENANT_ID);
  console.log('Local slugs:', localSlugs.size, 'Cloud rows:', cloudRows.length, 'Orphans:', orphans.length);
  for (const o of orphans) {
    console.log('  orphan:', o.slug, o.documentId, o.name);
  }

  if (DRY_RUN || orphans.length === 0) {
    if (DRY_RUN) console.log('DRY RUN — no deletes');
    process.exit(0);
  }

  let deleted = 0;
  for (const o of orphans) {
    await cloudFetch(`/api/saint-entries/${o.documentId}`, { method: 'DELETE' });
    console.log('Deleted:', o.slug);
    deleted++;
  }
  console.log('Done. deleted=', deleted);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
