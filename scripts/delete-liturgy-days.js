'use strict';

/**
 * Delete Liturgy Day entries.
 * Use before re-importing from PDF to avoid duplicates.
 *
 * Run from project root:
 *   node scripts/delete-liturgy-days.js              → delete ALL liturgy days (all tenants)
 *   node scripts/delete-liturgy-days.js --tenant-id=tenant_demo_002  → delete only that tenant's
 *
 * Optional: TENANT_ID=tenant_demo_002 or --tenant-id=tenant_demo_002 to limit to one tenant.
 * Optional: DRY_RUN=1 to only list count and skip deletion.
 */

try {
  require('dotenv').config();
} catch (_) {}

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

/** Returns tenant ID if provided via env or argv; otherwise null (meaning delete all). */
function getTenantId() {
  const env = process.env.TENANT_ID;
  if (env) return env.trim();
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--tenant-id' && process.argv[i + 1]) return process.argv[i + 1].trim();
    const match = arg.match(/^--tenant-id=(.+)$/);
    if (match) return match[1].trim();
  }
  return null;
}

const LITURGY_DAY_UID = 'api::liturgy-day.liturgy-day';

async function getTenant(strapi, tenantId) {
  const tenant = await strapi.db.query('api::tenant.tenant').findOne({
    where: { tenantId },
    select: ['id', 'documentId'],
  });
  return tenant;
}

async function getDocumentIdsForTenant(strapi, tenant) {
  const result = await strapi.documents(LITURGY_DAY_UID).findMany({
    filters: { tenant: tenant.id },
    limit: 10000,
  });
  const list = result?.results ?? result?.data ?? (Array.isArray(result) ? result : []);
  return list.map((doc) => doc.documentId).filter(Boolean);
}

async function deleteLiturgyDaysForTenant(strapi, tenantId) {
  const tenant = await getTenant(strapi, tenantId);
  if (!tenant) {
    console.error('Tenant not found:', tenantId);
    process.exitCode = 1;
    return;
  }

  const docIds = await getDocumentIdsForTenant(strapi, tenant);
  const count = docIds.length;
  if (count === 0) {
    console.log('Liturgy days: 0 entries for tenant', tenantId, '(skip)');
    return;
  }
  if (DRY_RUN) {
    console.log('Liturgy days:', count, 'entries for tenant', tenantId, '(DRY_RUN – not deleted)');
    return;
  }
  let deleted = 0;
  for (const documentId of docIds) {
    try {
      await strapi.documents(LITURGY_DAY_UID).delete({ documentId });
      deleted++;
    } catch (e) {
      console.warn('  Delete failed:', documentId, e.message);
    }
  }
  console.log('Liturgy days:', deleted, 'deleted for tenant', tenantId);
}

async function main() {
  const tenantId = getTenantId();
  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  try {
    if (DRY_RUN) console.log('DRY RUN – no da