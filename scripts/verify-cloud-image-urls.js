'use strict';
require('dotenv').config();
const u = process.env.STRAPI_CLOUD_URL.replace(/\/$/, '');
const t = process.env.STRAPI_CLOUD_API_TOKEN;
async function check(plural, field) {
  const q = `/api/${plural}?pagination[pageSize]=3&populate[0]=${field}&filters[tenant][tenantId][$eq]=tenant_demo_002`;
  const r = await fetch(u + q, { headers: { Authorization: `Bearer ${t}` } });
  const j = await r.json();
  for (const row of j.data || []) {
    const img = row[field]?.url;
    const kind = !img ? 'MISSING' : img.includes('amazonaws.com') ? 'S3' : img.includes('/uploads/') ? 'LOCAL' : 'OTHER';
    console.log(kind, plural, row.slug, img?.slice(0, 90) || '');
  }
}
(async () => {
  await check('training-programs', 'image');
  await check('catholicate-entries', 'image');
  await check('holy-synod-members', 'image');
})();
