'use strict';

try {
  require('dotenv').config();
} catch (_) {}

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';

if (!CLOUD_URL || !API_TOKEN) {
  console.error('Missing STRAPI_CLOUD_URL or STRAPI_CLOUD_API_TOKEN');
  process.exit(1);
}

async function cloudFetch(pathname) {
  const res = await fetch(`${CLOUD_URL}${pathname}`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function count(plural, tenantId) {
  const q = `/api/${plural}?filters[tenant][tenantId][$eq]=${encodeURIComponent(tenantId)}&pagination[pageSize]=1`;
  const data = await cloudFetch(q);
  return data.meta?.pagination?.total ?? 0;
}

async function main() {
  console.log('Cloud URL:', CLOUD_URL);
  const tenants = await cloudFetch('/api/tenants?pagination[pageSize]=50');
  const list = tenants.data || tenants.results || [];
  console.log('\nTenants on Cloud:');
  for (const t of list) {
    const tenantId = t.tenantId ?? t.attributes?.tenantId;
    const name = t.name ?? t.attributes?.name;
    console.log(`  - ${tenantId} (${name})`);
  }

  for (const tenantId of ['tenant_demo_002', 'mosc_malankara_orthodox_2']) {
    console.log(`\nCounts for ${tenantId}:`);
    for (const plural of ['dioceses', 'parishes', 'articles', 'kalpana-documents']) {
      try {
        const n = await count(plural, tenantId);
        console.log(`  ${plural}: ${n}`);
      } catch (e) {
        console.log(`  ${plural}: ERROR ${e.message}`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
