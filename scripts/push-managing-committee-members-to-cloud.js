'use strict';

/**
 * Push Directory – Managing Committee Members (roster) from local Strapi to Cloud.
 * Upserts by slug + tenant. Does NOT upload photos via ephemeral /api/upload —
 * use durable S3 after content push:
 *
 *   npm run push:collection-images-s3-to-cloud -- --collection=managing-committee-members --tenant-id=mosc_malankara_orthodox_2 --skip-api
 *
 * Prerequisites (.env):
 *   STRAPI_CLOUD_URL=https://YOUR-PROJECT.strapiapp.com
 *   STRAPI_CLOUD_API_TOKEN=...  (Full Access API token on Cloud)
 *
 * Run (local Strapi server stopped):
 *   set DRY_RUN=1&& npm run push:managing-committee-members-to-cloud -- --tenant-id=mosc_malankara_orthodox_2
 *   npm run push:managing-committee-members-to-cloud -- --tenant-id=mosc_malankara_orthodox_2 --term-year=2026
 *
 * Options:
 *   --tenant-id=XXX   Only push entries for this tenant (recommended)
 *   --term-year=2026  Filter local rows by termYear (default 2026)
 *   DRY_RUN=1         Preview counts; no HTTP writes
 */

try {
  require('dotenv').config();
} catch (_) {}

const { DRY_RUN, getTenantId } = require('./lib/liturgy-cli');

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const UID = 'api::managing-committee-member.managing-committee-member';
const PLURAL = 'managing-committee-members';

const TERM_YEAR = (() => {
  const m = process.argv.find((a) => a.startsWith('--term-year='));
  if (m) return parseInt(m.split('=')[1], 10) || 2026;
  return parseInt(process.env.TERM_YEAR || '2026', 10) || 2026;
})();

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function cloudFetch(pathname, options = {}) {
  const url = pathname.startsWith('http') ? pathname : `${CLOUD_URL}${pathname}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_TOKEN}`,
      ...options.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}: ${text.slice(0, 300)}`);
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

async function getCloudKeys(tenantIdFilter) {
  const map = new Map();
  let page = 1;
  const pageSize = 100;
  while (true) {
    let url = `/api/${PLURAL}?pagination[page]=${page}&pagination[pageSize]=${pageSize}&populate[tenant]=*`;
    if (tenantIdFilter) {
      url += `&filters[tenant][tenantId][$eq]=${encodeURIComponent(tenantIdFilter)}`;
    }
    if (TERM_YEAR) {
      url += `&filters[termYear][$eq]=${TERM_YEAR}`;
    }
    const data = await cloudFetch(url);
    const list = Array.isArray(data?.data) ? data.data : (data?.results ?? []);
    if (list.length === 0) break;
    for (const row of list) {
      const slug = row.slug ?? row.attributes?.slug;
      const tenantId =
        row.tenant?.tenantId ??
        row.tenant?.tenant_id ??
        row.tenant?.attributes?.tenantId ??
        row.tenant?.attributes?.tenant_id;
      if (slug && tenantId) {
        map.set(`${slug}_${tenantId}`, row.documentId ?? row.document_id ?? row.id);
      } else if (slug) {
        map.set(`${slug}_`, row.documentId ?? row.document_id ?? row.id);
      }
    }
    if (list.length < pageSize) break;
    page++;
  }
  return map;
}

function memberBelongsToTenant(row, tenant, tenantId) {
  const t = row.tenant;
  if (t) {
    const tid = t.tenantId ?? t.tenant_id;
    const docId = t.documentId ?? t.document_id;
    if (tid && tid === tenantId) return true;
    if (docId && (docId === tenant.documentId || docId === tenant.document_id)) return true;
    if (t.id != null && Number(t.id) === Number(tenant.id)) return true;
  }
  if (tenantId === 'mosc_malankara_orthodox_2') {
    return String(row.slug || '').endsWith('-mo2');
  }
  if (!t) return !String(row.slug || '').endsWith('-mo2');
  return false;
}

async function main() {
  if (!CLOUD_URL || !API_TOKEN) {
    console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN in .env');
    process.exit(1);
  }

  const tenantIdFilter = getTenantId({ defaultValue: 'mosc_malankara_orthodox_2' });

  const prevNodeEnv = process.env.NODE_ENV;
  if (!process.env.STRAPI_IMPORT_NODE_ENV) {
    process.env.NODE_ENV = 'staging';
  }

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const app = await createStrapi(await compileStrapi()).load();
  if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
  app.log.level = 'error';

  const localTenant = await app.db.query('api::tenant.tenant').findOne({
    where: { tenantId: tenantIdFilter },
    select: ['id', 'documentId', 'tenantId', 'name', 'domain', 'description'],
  });
  if (!localTenant) {
    console.error('Local tenant not found:', tenantIdFilter);
    await app.destroy();
    process.exit(1);
  }

  const result = await app.documents(UID).findMany({
    filters: { termYear: TERM_YEAR },
    limit: 2000,
    populate: { photo: true, tenant: true },
    sort: 'order:asc',
  });
  let list = result?.results ?? result?.data ?? (Array.isArray(result) ? result : []);
  list = list.filter((row) => memberBelongsToTenant(row, localTenant, tenantIdFilter));

  // Backfill local tenant links (import historically left tenant null)
  let backfilled = 0;
  for (const row of list) {
    if (row.tenant?.id || row.tenant?.documentId) continue;
    try {
      await app.db.query(UID).update({
        where: { documentId: row.documentId },
        data: { tenant: localTenant.id },
      });
      row.tenant = localTenant;
      backfilled++;
    } catch (_) {}
  }

  await app.destroy();

  if (list.length === 0) {
    console.log(
      `No managing committee members found locally for tenant ${tenantIdFilter} termYear=${TERM_YEAR}.`
    );
    process.exit(0);
  }

  console.log('Push Managing Committee Members to Cloud');
  console.log('  Cloud:', CLOUD_URL);
  console.log('  Tenant:', tenantIdFilter);
  console.log('  Term year:', TERM_YEAR);
  console.log('  Local entries:', list.length);
  console.log('  Local tenant backfilled:', backfilled);
  console.log('  Photos: deferred to push:collection-images-s3-to-cloud (durable S3)');
  if (DRY_RUN) console.log('  DRY_RUN=1');

  const withPhoto = list.filter((d) => d.photo?.url || d.photo?.documentId).length;
  console.log('  Local with photo:', withPhoto);

  if (DRY_RUN) {
    for (const doc of list.slice(0, 15)) {
      console.log(
        'Would push:',
        doc.slug,
        '|',
        doc.name,
        '| role=',
        doc.role || '-',
        '| photo=',
        doc.photo ? 'yes' : 'no'
      );
    }
    if (list.length > 15) console.log(`  ... +${list.length - 15} more`);
    process.exit(0);
  }

  let cloudTenants = await getCloudTenants();
  const cloudKeys = await getCloudKeys(tenantIdFilter);

  let cloudTenant = cloudTenants.get(tenantIdFilter);
  if (!cloudTenant) {
    cloudTenant = await createTenantOnCloud(localTenant);
    cloudTenants.set(tenantIdFilter, cloudTenant);
    console.log('Created tenant on Cloud:', tenantIdFilter);
  }
  const cloudTenantDocId = cloudTenant.documentId ?? cloudTenant.id;

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const doc of list) {
    const key = `${doc.slug}_${tenantIdFilter}`;
    const existingCloudDocId = cloudKeys.get(key) || cloudKeys.get(`${doc.slug}_`);

    const payload = {
      name: doc.name,
      slug: doc.slug,
      role: doc.role ?? null,
      diocese: doc.diocese ?? null,
      parish: doc.parish ?? null,
      address: doc.address ?? null,
      electedRegion: doc.electedRegion ?? null,
      serialNumber: doc.serialNumber ?? null,
      order: doc.order ?? 0,
      isCurrent: doc.isCurrent !== false,
      termYear: doc.termYear ?? TERM_YEAR,
      notes: doc.notes ?? null,
      tenant: cloudTenantDocId,
    };

    try {
      if (existingCloudDocId) {
        await cloudFetch(`/api/${PLURAL}/${existingCloudDocId}`, {
          method: 'PUT',
          body: JSON.stringify({ data: payload }),
        });
        updated++;
        console.log('Updated:', doc.slug);
      } else {
        const createRes = await cloudFetch(`/api/${PLURAL}`, {
          method: 'POST',
          body: JSON.stringify({ data: payload }),
        });
        const cloudDocId =
          createRes?.data?.documentId ?? createRes?.data?.document_id ?? createRes?.documentId;
        if (cloudDocId) cloudKeys.set(key, cloudDocId);
        created++;
        console.log('Created:', doc.slug);
        if (cloudDocId && cloudTenantDocId) {
          try {
            await cloudFetch(`/api/${PLURAL}/${cloudDocId}`, {
              method: 'PUT',
              body: JSON.stringify({ data: { tenant: cloudTenantDocId } }),
            });
          } catch (_) {}
        }
      }
    } catch (e) {
      console.warn('Failed', doc.slug, e.message);
      skipped++;
    }

    await sleep(120);
  }

  console.log('');
  console.log(
    'Done.',
    'Created:',
    created,
    'Updated:',
    updated,
    'Skipped:',
    skipped,
    '→',
    CLOUD_URL
  );
  console.log(
    'Next: npm run push:collection-images-s3-to-cloud -- --collection=managing-committee-members --tenant-id=' +
      tenantIdFilter +
      ' --skip-api'
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
