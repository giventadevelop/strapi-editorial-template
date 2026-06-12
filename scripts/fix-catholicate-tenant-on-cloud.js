'use strict';
/**
 * Restore tenant_demo_002 links on Cloud catholicate entries via migration API.
 */
require('dotenv').config({
  path: require('path').resolve(__dirname, '..', '.env'),
  override: true,
});

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const tenantId = process.env.TENANT_ID || 'tenant_demo_002';

(async () => {
  const listRes = await fetch(`${CLOUD_URL}/api/catholicate-entries?pagination[pageSize]=50&fields[0]=slug`);
  const slugs = ((await listRes.json()).data || []).map((r) => r.slug).filter(Boolean);
  const res = await fetch(`${CLOUD_URL}/api/migration/fix-published`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ linkCatholicateTenants: { tenantId, slugs } }),
  });
  const text = await res.text();
  console.log(res.status, text);
  process.exit(res.ok ? 0 : 1);
})();
