'use strict';

/**
 * Push Liturgy Day entries from local Strapi to Strapi Cloud (production).
 * - Resolves tenant from local entity table (document service may not return relation).
 * - Creates missing tenants on Cloud so no skips for "tenant not found".
 * - Upsert: if a liturgy day for the same date+tenant exists on Cloud, update it; otherwise create.
 *
 * Prerequisites:
 *   - Local Strapi has liturgy days and tenants.
 *   - .env has STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN (Full Access token on Cloud).
 *
 * Run (Strapi server stopped for local; Cloud must be reachable):
 *   node scripts/push-liturgy-days-to-cloud.js
 *   node scripts/push-liturgy-days-to-cloud.js --tenant-id=tenant_demo_002
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

/** GET tenants from Cloud; return Map tenantId -> { documentId, id, ... }. */
async function getCloudTenants() {
  const data = await cloudFetch('/api/tenants?pagination[pageSize]=500');
  const list = Array.isArray(data?.data) ? data.data : (data?.results ?? []);
  const map = new Map();
  for (const t of list) {
    const tenantId = t.tenantId ?? t.attributes?.tenantId ?? t.tenant_id ?? t.attributes?.tenant_id;
    if (tenantId) map.set(tenantId, { documentId: t.documentId ?? t.document_id ?? t.id, id: t.id, ...t });
  }
  return map;
}

/** POST a new tenant on Cloud. Returns { documentId, id }. */
async function createTenantOnCloud(localTenant) {
  const payload = {
    name: localTenant.name ?? localTenant.tenantId ?? 'Tenant',
    tenantId: localTenant.tenantId ?? localTenant.tenant_id,
    domain: localTenant.domain ?? localTenant.tenantId ?? 'example.com',
    description: localTenant.description ?? null,
  };
  const res = await cloudFetch('/api/tenants', {
    method: 'POST',
    body: JSON.stringify({ data: payload }),
  });
  const created = res?.data ?? res;
  return { documentId: created.documentId ?? created.document_id ?? created.id, id: created.id };
}

/** GET all liturgy days from Cloud; return Map "date_tenantId" -> documentId. */
async function getCloudLiturgyDayKeys() {
  const map = new Map();
  let page = 1;
  const pageSize = 100;
  while (true) {
    const data = await cloudFetch(
      `/api/liturgy-days?pagination[page]=${page}&pagination[pageSize]=${pageSize}&populate[tenant]=*`
    );
    const list = Array.isArray(data?.data) ? data.data : (data?.results ?? []);
    if (list.length === 0) break;
    for (const d of list) {
      const date = typeof d.date === 'string' ? d.date.slice(0, 10) : (d.date && d.date.toISOString && d.date.toISOString().slice(0, 10));
      const tenantId = d.tenant?.tenantId ?? d.tenant?.tenant_id ?? d.tenant?.attributes?.tenantId ?? d.tenant?.attributes?.tenant_id;
      if (date && tenantId) map.set(`${date}_${tenantId}`, d.documentId ?? d.document_id ?? d.id);
    }
    if (list.length < pageSize) break;
    page++;
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
    populate: { tenant: true },
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
      const filtered = await app.documents(LITURGY_DAY_UID).findMany({ filters, limit: 10000 });
      list = filtered?.results ?? filtered?.data ?? (Array.isArray(filtered) ? filtered : []);
    }
  }

  const localTenants = await app.db.query('api::tenant.tenant').findMany({
    where: {},
    select: ['id', 'documentId', 'tenantId', 'name', 'domain', 'description'],
  });
  const localTenantById = new Map();
  const localTenantByTenantId = new Map();
  for (const t of localTenants || []) {
    if (t.id != null) localTenantById.set(t.id, t);
    const tid = t.tenantId ?? t.tenant_id;
    if (tid) localTenantByTenantId.set(tid, t);
  }

  const docIdToTenantId = new Map();
  for (const doc of list) {
    const docId = doc.documentId ?? doc.document_id;
    const localTenant = doc.tenant;
    const tenantId =
      (typeof localTenant === 'object' && (localTenant?.tenantId ?? localTenant?.tenant_id)) ??
      (typeof localTenant === 'object' && localTenant?.id != null && localTenantById.get(localTenant.id)?.tenantId) ??
      (typeof localTenant === 'number' && localTenantById.get(localTenant)?.tenantId) ??
      null;
    if (docId != null && tenantId) docIdToTenantId.set(String(docId), tenantId);
  }
  if (docIdToTenantId.size === 0 && list.length > 0 && app.db.connection) {
    let names = [];
    try {
      const tables = await app.db.connection.raw("SELECT name FROM sqlite_master WHERE type='table'");
      let rows = [];
      if (Array.isArray(tables) && tables.length > 0) {
        rows = Array.isArray(tables[0]) ? tables[0] : tables;
      } else if (tables && typeof tables === 'object' && Array.isArray(tables.rows)) {
        rows = tables.rows;
      }
      names = Array.isArray(rows) ? rows.map((r) => (r && (r.name || r.NAME)) || '').filter(Boolean) : [];
    } catch (_) {}
    const linkTable = names.find((n) => n.includes('liturgy') && (n.includes('tenant') || n.includes('lnk')));
    if (linkTable) {
      try {
        const raw = await app.db.connection(linkTable).select('*').limit(5000);
        for (const row of raw || []) {
          const docId = row.document_id ?? row.liturgy_day_id ?? row.left_id;
          const tenantFk = row.tenant_id ?? row.right_id;
          if (docId != null && tenantFk != null) {
            const t = localTenantById.get(tenantFk);
            if (t) docIdToTenantId.set(String(docId), t.tenantId ?? t.tenant_id);
          }
        }
      } catch (_) {}
    }
    if (docIdToTenantId.size === 0 && tenantIdFilter) {
      for (const doc of list) {
        const docId = doc.documentId ?? doc.document_id;
        if (docId) docIdToTenantId.set(String(docId), tenantIdFilter);
      }
    }
  }
  if (docIdToTenantId.size === 0 && tenantIdFilter && list.length > 0) {
    for (const doc of list) {
      const docId = doc.documentId ?? doc.document_id;
      if (docId) docIdToTenantId.set(String(docId), tenantIdFilter);
    }
  }
  await app.destroy();

  if (list.length === 0) {
    console.log('No liturgy days found locally' + (tenantIdFilter ? ' for tenant ' + tenantIdFilter : '') + '.');
    process.exit(0);
  }

  if (DRY_RUN) {
    const sampleTenantId = docIdToTenantId.get(String(list[0]?.documentId)) ?? list[0]?.tenant?.tenantId ?? list[0]?.tenant?.id;
    console.log('DRY_RUN: would push', list.length, 'liturgy days to', CLOUD_URL);
    console.log('Sample date:', list[0]?.date, 'resolved tenantId:', sampleTenantId);
    process.exit(0);
  }

  let cloudTenants = await getCloudTenants();
  if (cloudTenants.size === 0) {
    console.log('No tenants on Cloud yet. Will create tenants from local as needed.');
  } else {
    console.log('Cloud tenants:', [...cloudTenants.keys()].join(', '));
  }

  const cloudLiturgyKeys = await getCloudLiturgyDayKeys();
  console.log('Existing liturgy days on Cloud:', cloudLiturgyKeys.size);

  let created = 0;
  let updated = 0;
  let skip = 0;
  for (let i = 0; i < list.length; i++) {
    const doc = list[i];
    const docIdStr = doc.documentId != null ? String(doc.documentId) : (doc.document_id != null ? String(doc.document_id) : null);
    let tenantId = tenantIdFilter
      ? tenantIdFilter
      : docIdToTenantId.get(docIdStr) ??
        (typeof doc.tenant === 'object' && (doc.tenant?.tenantId ?? doc.tenant?.tenant_id)) ??
        (typeof doc.tenant === 'object' && doc.tenant?.id != null && localTenantById.get(doc.tenant.id)?.tenantId) ??
        (typeof doc.tenant === 'number' && localTenantById.get(doc.tenant)?.tenantId) ??
        null;
    if ((!tenantId || tenantId === '') && tenantIdFilter) tenantId = tenantIdFilter;

    if (!tenantId) {
      console.warn('Skip date', doc.date, ': could not resolve tenantId from local data.');
      skip++;
      continue;
    }

    let cloudTenant = cloudTenants.get(tenantId);
    if (!cloudTenant) {
      const localTenant = localTenantByTenantId.get(tenantId);
      if (!localTenant) {
        console.warn('Skip date', doc.date, ': tenant', tenantId, 'not in local DB.');
        skip++;
        continue;
      }
      try {
        cloudTenant = await createTenantOnCloud(localTenant);
        cloudTenants.set(tenantId, cloudTenant);
        console.log('Created tenant on Cloud:', tenantId);
      } catch (e) {
        console.warn('Skip date', doc.date, ': failed to create tenant', tenantId, e.message);
        skip++;
        continue;
      }
      await sleep(200);
    }

    const cloudTenantDocId = cloudTenant.documentId ?? cloudTenant.id;
    const dateStr = typeof doc.date === 'string' ? doc.date.slice(0, 10) : (doc.date && doc.date.toISOString && doc.date.toISOString().slice(0, 10));
    const key = `${dateStr}_${tenantId}`;
    const existingCloudDocId = cloudLiturgyKeys.get(key);

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
      if (existingCloudDocId) {
        await cloudFetch(`/api/liturgy-days/${existingCloudDocId}`, {
          method: 'PUT',
          body: JSON.stringify({ data: payload }),
        });
        updated++;
        if (list.length > 20 && (created + updated) % 50 === 0) console.log('Upserted', created + updated, '/', list.length);
      } else {
        const createRes = await cloudFetch('/api/liturgy-days', {
          method: 'POST',
          body: JSON.stringify({ data: payload }),
        });
        const newDocId = createRes?.data?.documentId ?? createRes?.data?.document_id ?? createRes?.documentId;
        if (newDocId && cloudTenantDocId) {
          try {
            await cloudFetch(`/api/liturgy-days/${newDocId}`, {
              method: 'PUT',
              body: JSON.stringify({ data: { tenant: cloudTenantDocId } }),
            });
          } catch (_) {}
        }
        created++;
        if (list.length > 20 && (created + updated) % 50 === 0) console.log('Upserted', created + updated, '/', list.length);
      }
    } catch (e) {
      console.warn('Failed', doc.date, e.message);
    }
    await sleep(100);
  }

  console.log('');
  console.log('Done.', 'Created:', created, 'Updated:', updated, 'Skipped:', skip, '→', CLOUD_URL);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
