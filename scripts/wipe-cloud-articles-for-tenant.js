'use strict';

/**
 * Delete ALL Cloud articles for a tenant (including orphan -mo2 slug rows
 * with missing tenant), then optionally list remaining.
 *
 *   node scripts/wipe-cloud-articles-for-tenant.js --tenant-id=mosc_malankara_orthodox_2
 *   node scripts/wipe-cloud-articles-for-tenant.js --tenant-id=mosc_malankara_orthodox_2 --dry-run
 */

try {
  require('dotenv').config();
} catch (_) {}

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const DRY_RUN = process.argv.includes('--dry-run');
const TENANT_ID =
  (process.argv.find((a) => a.startsWith('--tenant-id=')) || '').split('=')[1] ||
  'mosc_malankara_orthodox_2';

async function cloudFetch(pathname, options = {}) {
  const url = pathname.startsWith('http') ? pathname : `${CLOUD_URL}${pathname}`;
  const res = await fetch(url, {
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
    json = { raw: text?.slice(0, 400) };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}: ${text.slice(0, 300)}`);
  return json;
}

async function fetchAllPages(buildPath) {
  const rows = [];
  let page = 1;
  for (;;) {
    const json = await cloudFetch(buildPath(page));
    const batch = Array.isArray(json.data) ? json.data : [];
    rows.push(...batch);
    const pageCount = json.meta?.pagination?.pageCount ?? 1;
    if (page >= pageCount || batch.length === 0) break;
    page++;
  }
  return rows;
}

(async () => {
  if (!CLOUD_URL || !API_TOKEN) {
    console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN');
    process.exit(1);
  }

  console.log('Wipe Cloud articles for tenant');
  console.log('  Tenant:', TENANT_ID);
  console.log('  Dry run:', DRY_RUN);

  const byTenant = await fetchAllPages(
    (page) =>
      `/api/articles?filters[tenant][tenantId][$eq]=${encodeURIComponent(TENANT_ID)}&pagination[page]=${page}&pagination[pageSize]=100&fields[0]=slug&fields[1]=title&populate[tenant]=true`
  );

  // Also catch orphan production slugs that lost tenant (mo2 / -mr-mo2 patterns)
  const all = await fetchAllPages(
    (page) =>
      `/api/articles?pagination[page]=${page}&pagination[pageSize]=100&fields[0]=slug&fields[1]=title&populate[tenant]=true`
  );
  const orphanMo2 = all.filter((r) => {
    const slug = String(r.slug || '');
    const tid = r.tenant?.tenantId;
    if (tid === TENANT_ID) return false; // already in byTenant
    return /(?:^|-)mo2(?:-|$)/i.test(slug) || slug.endsWith('-mo2') || slug.includes('-mr-mo2');
  });

  const byDoc = new Map();
  for (const row of [...byTenant, ...orphanMo2]) {
    if (row.documentId) byDoc.set(row.documentId, row);
  }

  console.log('  Linked to tenant:', byTenant.length);
  console.log('  Orphan mo2-like:', orphanMo2.length);
  console.log('  Unique to delete:', byDoc.size);

  let deleted = 0;
  let failed = 0;
  for (const [docId, row] of byDoc) {
    const label = `${row.slug || '(no-slug)'} | ${(row.title || '').slice(0, 40)}`;
    if (DRY_RUN) {
      console.log('  Would delete', docId, label);
      deleted++;
      continue;
    }
    try {
      await cloudFetch(`/api/articles/${docId}`, { method: 'DELETE' });
      deleted++;
      if (deleted % 10 === 0) console.log(`  Deleted ${deleted}/${byDoc.size}...`);
    } catch (e) {
      failed++;
      console.warn('  Delete failed', docId, e.message);
    }
  }

  console.log('Done. deleted=', deleted, 'failed=', failed);

  if (!DRY_RUN) {
    const remaining = await fetchAllPages(
      (page) =>
        `/api/articles?filters[tenant][tenantId][$eq]=${encodeURIComponent(TENANT_ID)}&pagination[page]=${page}&pagination[pageSize]=100&fields[0]=slug`
    );
    console.log('  Remaining for tenant:', remaining.length);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
