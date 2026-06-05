'use strict';

/**
 * Replicate Liturgy Day records from local Strapi DB to Strapi Cloud (production).
 * Reads corrected local data (e.g. after monthly English heading fixes) and upserts
 * matching Cloud records by date + tenant. Does not touch articles or other types.
 *
 * Prerequisites (.env):
 *   STRAPI_CLOUD_URL=https://YOUR-PROJECT.strapiapp.com
 *   STRAPI_CLOUD_API_TOKEN=...  (Full Access API token on Cloud)
 *
 * Run (local Strapi stopped):
 *   DRY_RUN=1 node scripts/sync-liturgy-calendar-local-to-cloud.js --tenant-id=tenant_demo_002
 *   node scripts/sync-liturgy-calendar-local-to-cloud.js --tenant-id=tenant_demo_002
 *   node scripts/sync-liturgy-calendar-local-to-cloud.js --tenant-id=tenant_demo_002 --english-only
 *   node scripts/sync-liturgy-calendar-local-to-cloud.js --tenant-id=tenant_demo_002 --year=2026 --verify-cloud
 *
 * Options:
 *   --tenant-id=XXX     Tenant to sync (recommended; omit = all local liturgy days)
 *   --year=YYYY         Only sync dates in this calendar year (default: all years)
 *   --english-only      Update/create dayHeadingEn only on Cloud (Malayalam/season unchanged on update)
 *   --verify-cloud      After sync, count liturgy days on Cloud for the tenant
 *   DRY_RUN=1           Preview counts; no HTTP writes
 */

const { DRY_RUN, getArg, getTenantId, getYear, hasFlag } = require('./lib/liturgy-cli');

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const LITURGY_DAY_UID = 'api::liturgy-day.liturgy-day';

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
      const date =
        typeof d.date === 'string'
          ? d.date.slice(0, 10)
          : d.date?.toISOString?.()?.slice(0, 10);
      const tenantId =
        d.tenant?.tenantId ??
        d.tenant?.tenant_id ??
        d.tenant?.attributes?.tenantId ??
        d.tenant?.attributes?.tenant_id;
      if (date && tenantId) map.set(`${date}_${tenantId}`, d.documentId ?? d.document_id ?? d.id);
    }
    if (list.length < pageSize) break;
    page++;
  }
  return map;
}

async function countCloudLiturgyForTenant(tenantId) {
  let page = 1;
  let count = 0;
  while (true) {
    const data = await cloudFetch(
      `/api/liturgy-days?pagination[page]=${page}&pagination[pageSize]=100&populate[tenant]=*&filters[tenant][tenantId][$eq]=${encodeURIComponent(tenantId)}`
    );
    const list = Array.isArray(data?.data) ? data.data : (data?.results ?? []);
    count += list.length;
    if (list.length < 100) break;
    page++;
  }
  return count;
}

function tenantFilters(tenant) {
  const docId = tenant.documentId ?? tenant.document_id;
  return docId != null
    ? { $or: [{ tenant: tenant.id }, { tenant: { documentId: docId } }] }
    : { tenant: tenant.id };
}

function dateInYear(dateStr, year) {
  if (!year) return true;
  return dateStr && dateStr.startsWith(`${year}-`);
}

function buildPayload(doc, cloudTenantDocId, englishOnly) {
  if (englishOnly) {
    return {
      dayHeadingEn: doc.dayHeadingEn ?? null,
    };
  }
  return {
    date: doc.date,
    dayHeadingEn: doc.dayHeadingEn ?? null,
    dayHeadingMalylm: doc.dayHeadingMalylm ?? null,
    seasonNameEn: doc.seasonNameEn ?? null,
    seasonNameMalylm: doc.seasonNameMalylm ?? null,
    order: doc.order ?? 0,
    readings: Array.isArray(doc.readings) ? doc.readings : [],
    tenant: cloudTenantDocId,
  };
}

function buildCreatePayload(doc, cloudTenantDocId, englishOnly) {
  if (englishOnly) {
    return {
      date: doc.date,
      dayHeadingEn: doc.dayHeadingEn ?? null,
      dayHeadingMalylm: null,
      seasonNameEn: null,
      seasonNameMalylm: null,
      order: doc.order ?? 0,
      readings: [],
      tenant: cloudTenantDocId,
    };
  }
  return buildPayload(doc, cloudTenantDocId, false);
}

async function loadLocalLiturgyDays(tenantIdFilter) {
  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const app = await createStrapi(await compileStrapi()).load();
  app.log.level = 'error';

  let list = [];
  if (tenantIdFilter) {
    const tenant = await app.db.query('api::tenant.tenant').findOne({
      where: { tenantId: tenantIdFilter },
      select: ['id', 'documentId', 'document_id'],
    });
    if (!tenant) {
      await app.destroy();
      throw new Error('Local tenant not found: ' + tenantIdFilter);
    }
    const result = await app.documents(LITURGY_DAY_UID).findMany({
      filters: tenantFilters(tenant),
      limit: 50000,
    });
    list = result?.results ?? result?.data ?? (Array.isArray(result) ? result : []);
  } else {
    const result = await app.documents(LITURGY_DAY_UID).findMany({ limit: 50000 });
    list = result?.results ?? result?.data ?? (Array.isArray(result) ? result : []);
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
      tenantIdFilter ??
      (typeof localTenant === 'object' && (localTenant?.tenantId ?? localTenant?.tenant_id)) ??
      (typeof localTenant === 'object' &&
        localTenant?.id != null &&
        localTenantById.get(localTenant.id)?.tenantId) ??
      (typeof localTenant === 'number' && localTenantById.get(localTenant)?.tenantId) ??
      null;
    if (docId != null && tenantId) docIdToTenantId.set(String(docId), tenantId);
  }

  if (docIdToTenantId.size === 0 && tenantIdFilter && list.length > 0) {
    for (const doc of list) {
      const docId = doc.documentId ?? doc.document_id;
      if (docId) docIdToTenantId.set(String(docId), tenantIdFilter);
    }
  }

  await app.destroy();
  return { list, localTenantByTenantId, docIdToTenantId };
}

async function main() {
  if (!CLOUD_URL || !API_TOKEN) {
    console.error('Missing Cloud credentials. Set in .env:');
    console.error('  STRAPI_CLOUD_URL=https://YOUR-PROJECT.strapiapp.com');
    console.error('  STRAPI_CLOUD_API_TOKEN=your-full-access-api-token');
    process.exit(1);
  }

  const tenantIdFilter = getTenantId({ defaultValue: null });
  const yearArg = getArg('year', null);
  const yearFilter = yearArg != null && String(yearArg).trim() !== '' ? getYear() : null;
  const englishOnly = hasFlag('english-only');
  const verifyCloud = hasFlag('verify-cloud');

  console.log('Sync liturgy calendar: local → Cloud (production)');
  console.log('  Cloud URL:', CLOUD_URL);
  console.log('  Tenant:', tenantIdFilter || '(all local tenants)');
  console.log('  Year filter:', yearFilter || '(none)');
  console.log('  Mode:', englishOnly ? 'English headings only (dayHeadingEn)' : 'All liturgy fields');
  if (DRY_RUN) console.log('  DRY_RUN=1: no Cloud writes');
  console.log('');

  const { list, localTenantByTenantId, docIdToTenantId } = await loadLocalLiturgyDays(tenantIdFilter);

  const filtered = list.filter((doc) => {
    const dateStr =
      typeof doc.date === 'string'
        ? doc.date.slice(0, 10)
        : doc.date?.toISOString?.()?.slice(0, 10);
    return dateInYear(dateStr, yearFilter);
  });

  if (filtered.length === 0) {
    console.log('No local liturgy days to sync' + (tenantIdFilter ? ' for tenant ' + tenantIdFilter : '') + '.');
    process.exit(0);
  }

  console.log('Local records to sync:', filtered.length);

  if (DRY_RUN) {
    const sample = filtered[0];
    const sampleDate =
      typeof sample.date === 'string'
        ? sample.date.slice(0, 10)
        : sample.date?.toISOString?.()?.slice(0, 10);
    const sampleTenant =
      tenantIdFilter ??
      docIdToTenantId.get(String(sample.documentId ?? sample.document_id)) ??
      '?';
    console.log('Sample:', sampleDate, 'tenant:', sampleTenant);
    console.log('Sample EN (first 80 chars):', (sample.dayHeadingEn || '').slice(0, 80));
    process.exit(0);
  }

  let cloudBefore = null;
  if (tenantIdFilter && verifyCloud) {
    try {
      cloudBefore = await countCloudLiturgyForTenant(tenantIdFilter);
      console.log('Cloud liturgy count before sync:', cloudBefore);
    } catch (e) {
      console.warn('Could not count Cloud records before sync:', e.message);
    }
  }

  let cloudTenants = await getCloudTenants();
  const cloudLiturgyKeys = await getCloudLiturgyDayKeys();
  console.log('Existing liturgy days on Cloud (all tenants):', cloudLiturgyKeys.size);
  console.log('');

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < filtered.length; i++) {
    const doc = filtered[i];
    const docIdStr =
      doc.documentId != null
        ? String(doc.documentId)
        : doc.document_id != null
          ? String(doc.document_id)
          : null;

    let tenantId =
      tenantIdFilter ??
      docIdToTenantId.get(docIdStr) ??
      (typeof doc.tenant === 'object' && (doc.tenant?.tenantId ?? doc.tenant?.tenant_id)) ??
      null;

    if (!tenantId) {
      console.warn('Skip (no tenant):', doc.date);
      skipped++;
      continue;
    }

    let cloudTenant = cloudTenants.get(tenantId);
    if (!cloudTenant) {
      const localTenant = localTenantByTenantId.get(tenantId);
      if (!localTenant) {
        console.warn('Skip (tenant not local):', doc.date, tenantId);
        skipped++;
        continue;
      }
      try {
        cloudTenant = await createTenantOnCloud(localTenant);
        cloudTenants.set(tenantId, cloudTenant);
        console.log('Created tenant on Cloud:', tenantId);
      } catch (e) {
        console.warn('Skip (create tenant failed):', tenantId, e.message);
        skipped++;
        continue;
      }
      await sleep(200);
    }

    const cloudTenantDocId = cloudTenant.documentId ?? cloudTenant.id;
    const dateStr =
      typeof doc.date === 'string'
        ? doc.date.slice(0, 10)
        : doc.date?.toISOString?.()?.slice(0, 10);
    const key = `${dateStr}_${tenantId}`;
    const existingCloudDocId = cloudLiturgyKeys.get(key);

    try {
      if (existingCloudDocId) {
        const payload = buildPayload(doc, cloudTenantDocId, englishOnly);
        await cloudFetch(`/api/liturgy-days/${existingCloudDocId}`, {
          method: 'PUT',
          body: JSON.stringify({ data: payload }),
        });
        if (!englishOnly && cloudTenantDocId) {
          try {
            await cloudFetch(`/api/liturgy-days/${existingCloudDocId}`, {
              method: 'PUT',
              body: JSON.stringify({ data: { tenant: cloudTenantDocId } }),
            });
          } catch (_) {}
        }
        updated++;
      } else {
        const payload = buildCreatePayload(doc, cloudTenantDocId, englishOnly);
        const createRes = await cloudFetch('/api/liturgy-days', {
          method: 'POST',
          body: JSON.stringify({ data: payload }),
        });
        const newDocId =
          createRes?.data?.documentId ??
          createRes?.data?.document_id ??
          createRes?.documentId;
        if (newDocId) {
          cloudLiturgyKeys.set(key, newDocId);
          if (cloudTenantDocId) {
            try {
              await cloudFetch(`/api/liturgy-days/${newDocId}`, {
                method: 'PUT',
                body: JSON.stringify({ data: { tenant: cloudTenantDocId } }),
              });
            } catch (_) {}
          }
        }
        created++;
      }
      if (filtered.length > 20 && (created + updated) % 50 === 0) {
        console.log('Progress:', created + updated, '/', filtered.length);
      }
    } catch (e) {
      console.warn('Failed', dateStr, e.message);
      failed++;
    }
    await sleep(100);
  }

  console.log('');
  console.log('Sync complete →', CLOUD_URL);
  console.log('  Created:', created);
  console.log('  Updated:', updated);
  console.log('  Skipped:', skipped);
  if (failed) console.log('  Failed:', failed);

  if (tenantIdFilter && verifyCloud) {
    try {
      const cloudAfter = await countCloudLiturgyForTenant(tenantIdFilter);
      console.log('  Cloud liturgy count after sync:', cloudAfter);
      if (cloudBefore != null) console.log('  Delta:', cloudAfter - cloudBefore);
    } catch (e) {
      console.warn('Could not count Cloud records after sync:', e.message);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
