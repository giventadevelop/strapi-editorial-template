'use strict';

/**
 * Push Liturgy Day entries from local Strapi to Strapi Cloud (production).
 * Use when production already has tenants and other content and you only want
 * to add or sync liturgy days. Reads from local DB and POSTs to Cloud Content API.
 *
 * Prerequisites:
 *   - Local Strapi has liturgy days (e.g. from import-liturgy-days-from-pdf.js).
 *   - Production (Cloud) has the same tenant(s) created (e.g. tenant_production_001).
 *   - .env has STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN (Full Access token on Cloud).
 *
 * Run (Strapi server stopped for local; Cloud must be reachable):
 *   node scripts/push-liturgy-days-to-cloud.js
 *   node scripts/push-liturgy-days-to-cloud.js --tenant-id=tenant_production_001
 *   DRY_RUN=1 node scripts/push-liturgy-days-to-cloud.js
 *
 * Options:
 *   --tenant-id=XXX   (optional) Only push liturgy days for this tenant; omit to push all.
 *   DRY_RUN=1         Log what would be sent; no HTTP requests.
 */

try {
  require('dotenv').config();
} catch (_) {}

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';

function getArg(name, defaultValue) {
  const envMap = { tenantId: process.env.TENANT_ID };
  if (envMap[name]) return envMap[name];
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    const match = arg.match(new RegExp(`^--${name}=(.+)$`));
    if (match) return match[1].trim();
  }
  return defaultValue;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function cloudFetch(path, options = {}) {
  const url = path.startsWith('http') ? path : `${CLOUD_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_TOKEN}`,
      ...options.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/** GET tenants from Cloud; return Map tenantId -> { documentId, id }. */
async function getCloudTenants() {
  const data = await cloudFetch('/api/tenants?pagination[pageSize]=500');
  const list = Array.isArray(data?.data) ? data.data : (data?.results ?? []);
  const map = new Map();
  for (const t of list) {
    const tenantId = t.tenantId ?? t.tenant_id;
    if (tenantId) map.set(tenantId, { documentId: t.documentId ?? t.document_id, id: t.id });
  }
  return map;
}

const LITURGY_DAY_UID = 'api::liturgy-day.liturgy-day';

async function main() {
  if (!CLOUD_URL || !API_TOKEN) {
    console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN in .env');
    process.exit(1);
  }

  const tenantIdFilter = getArg('tenantId', getArg('tenant-id', null));

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  const result = await app.documents(LITURGY_DAY_UID).findMany({
    limit: 10000,
  });
  let list = result?.results ?? result?.data ?? (Array.isArray(result) ? result : []);
  if (tenantIdFilter && list.length > 0) {
    const tenant = await app.db.query('api::tenant.tenant').findOne({
      where: { tenantId: tenantIdFilter },
      select: ['id', 'documentId'],
    });
    if (tenant) {
      const docId = tenant.documentId ?? tenant.document_id;
      const filters =
        docId != null
          ? { $or: [{ tenant: tenant.id }, { tenant: { documentId: docId } }] }
          : { tenant: tenant.id };
      const filtered = await app.documents(LITURGY_DAY_UID).findMany({
        filters,
        limit: 10000,
      });
      list = filtered?.results ?? filtered?.data ?? (Array.isArray(filtered) ? filtered : []);
    }
  }
  const tenantIds = await app.db.query('api::tenant.tenant').findMany({
    where: {},
    select: ['id', 'documentId', 'tenantId'],
  });
  const localTenantById = new Map();
  const localTenantByDocId = new Map();
  for (const t of tenantIds || []) {
    if (t.id != null) localTenantById.set(t.id, t);
    const docId = t.documentId ?? t.document_id;
    if (docId != null) localTenantByDocId.set(String(docId), t);
  }
  await app.destroy();

  if (list.length === 0) {
    console.log('No liturgy days found locally' + (tenantIdFilter ? ' for tenant ' + tenantIdFilter : '') + '.');
    process.exit(0);
  }

  if (DRY_RUN) {
    console.log('DRY_RUN: would push', list.length, 'liturgy days to', CLOUD_URL);
    console.log('First entry date:', list[0]?.date, 'tenant:', list[0]?.tenant?.tenantId ?? list[0]?.tenant?.id);
    process.exit(0);
  }

  const cloudTenants = await getCloudTenants();
  if (cloudTenants.size === 0) {
    console.error('No tenants found on Cloud. Create at least one tenant (e.g. tenant_production_001) in Cloud Admin.');
    process.exit(1);
  }
  console.log('Cloud tenants:', [...cloudTenants.keys()].join(', '));

  let ok = 0;
  let skip = 0;
  for (let i = 0; i < list.length; i++) {
    const doc = list[i];
    const localTenant = doc.tenant;
    let tenantId = null;
    if (localTenant != null) {
      if (typeof localTenant === 'object') {
        tenantId = localTenant.tenantId ?? localTenant.tenant_id ?? localTenantById.get(localTenant.id)?.tenantId ?? localTenantByDocId.get(String(localTenant.documentId ?? localTenant.document_id))?.tenantId;
      } else {
        tenantId = localTenantById.get(localTenant)?.tenantId ?? null;
      }
    }
    const cloudTenant = tenantId ? cloudTenants.get(tenantId) : null;
    const cloudTenantDocId = cloudTenant?.documentId ?? cloudTenant?.id;

    if (!cloudTenantDocId) {
      console.warn('Skip date', doc.date, ': tenant', tenantId || localTenant?.id, 'not found on Cloud.');
      skip++;
      continue;
    }

    const payload = {
      date: doc.date,
      dayHeadingEn: doc.dayHeadingEn ?? null,
      dayHeadingMalylm: doc.dayHeadingMalylm ?? null,
      seasonNameEn: doc.seasonNameEn ?? null,
      seasonNameMalylm: doc.seasonNameMalylm ?? null,
      order: doc.order ?? 0,
      readings: Array.isArray(doc.readings) ? doc.readings : [],
      tenant: cloudTenantDocId,
    };

    try {
      await cloudFetch('/api/liturgy-days', {
        method: 'POST',
        body: JSON.stringify({ data: payload }),
      });
      ok++;
      if (list.length > 20 && ok % 50 === 0) console.log('Pushed', ok, '/', list.length);
    } catch (e) {
      console.warn('Failed', doc.date, e.message);
    }
    await sleep(100);
  }

  console.log('');
  console.log('Pushed', ok, 'liturgy days to', CLOUD_URL + (skip > 0 ? '; skipped ' + skip + ' (tenant not on Cloud)' : ''));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
