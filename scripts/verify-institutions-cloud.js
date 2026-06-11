'use strict';
/**
 * Verify Institutions entries on Strapi Cloud (tenant + contact fields + image).
 * Usage: node scripts/verify-institutions-cloud.js
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
  const url = `${CLOUD_URL}/api/institutions?pagination[pageSize]=1&filters[tenant][tenantId][$eq]=${encodeURIComponent(tenantId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${API_TOKEN}` } });
  if (res.status === 404) {
    console.error('HTTP 404: institutions API not found on Cloud. Deploy schemas first.');
    process.exit(1);
  }
  const json = await res.json();
  const total = json?.meta?.pagination?.total ?? 0;
  console.log('Total on Cloud:', total, '| tenant filter:', tenantId);

  let page = 1;
  const pageSize = 100;
  let shown = 0;
  while (shown < Math.min(total, 15)) {
    const pageUrl = `${CLOUD_URL}/api/institutions?pagination[page]=${page}&pagination[pageSize]=${pageSize}&populate[0]=tenant&populate[1]=image&filters[tenant][tenantId][$eq]=${encodeURIComponent(tenantId)}&sort=order:asc`;
    const pageRes = await fetch(pageUrl, { headers: { Authorization: `Bearer ${API_TOKEN}` } });
    const pageJson = await pageRes.json();
    const list = pageJson?.data ?? [];
    if (list.length === 0) break;
    for (const row of list) {
      if (shown >= 15) break;
      const tid = row.tenant?.tenantId ?? row.tenant?.tenant_id ?? '?';
      const img = row.image ? (row.image.url || row.image.name || 'linked') : 'MISSING';
      console.log(row.order, row.slug, '| tenant:', tid, '| image:', img);
      shown++;
    }
    if (list.length < pageSize) break;
    page++;
  }
  if (total > 15) console.log('... and', total - 15, 'more');
})();
