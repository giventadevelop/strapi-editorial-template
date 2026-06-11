'use strict';
/**
 * Verify Publications entries on Strapi Cloud (tenant + contact fields + image).
 * Usage: node scripts/verify-publications-cloud.js
 * Optional: --tenant-id=tenant_demo_002 (default from TENANT_ID env or tenant_demo_002)
 */
try { require('dotenv').config(); } catch (_) {}
const { getTenantId } = require('./lib/liturgy-cli');

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const tenantId = getTenantId({ defaultValue: 'tenant_demo_002' });

(async () => {
  if (!CLOUD_URL || !API_TOKEN) {
    console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN');
    process.exit(1);
  }
  const url = `${CLOUD_URL}/api/publication-entries?pagination[pageSize]=100&populate[0]=tenant&populate[1]=image&filters[tenant][tenantId][$eq]=${encodeURIComponent(tenantId)}&sort=order:asc`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${API_TOKEN}` } });
  if (res.status === 404) {
    console.error('HTTP 404: publication-entries API not found on Cloud. Deploy schemas first: npx strapi login && npx strapi deploy --force');
    process.exit(1);
  }
  const json = await res.json();
  const list = json?.data ?? [];
  console.log('Count:', list.length, '| tenant filter:', tenantId);
  for (const row of list) {
    const tid = row.tenant?.tenantId ?? row.tenant?.tenant_id ?? '?';
    const img = row.image ? (row.image.url || row.image.name || 'linked') : 'MISSING';
    console.log(row.order, row.slug, '| tenant:', tid, '| email:', row.email || '—', '| image:', img);
  }
})();
