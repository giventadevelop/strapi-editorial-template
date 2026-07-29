'use strict';

/**
 * Restore article tenant links wiped by Document Service updates.
 * Heuristic: slug contains -mo2 / ends with mo2 → mosc_malankara_orthodox_2, else tenant_demo_002.
 *
 *   node scripts/repair-article-tenants-by-slug.js
 *   node scripts/repair-article-tenants-by-slug.js --dry-run
 */

try {
  require('dotenv').config();
} catch (_) {}

const { createStrapi, compileStrapi } = require('@strapi/strapi');
const {
  getTenantJoinTable,
  ensureTenantLinkOnRow,
} = require('../src/utils/tenant-assignment');

const DRY_RUN = process.argv.includes('--dry-run');
const ARTICLE_UID = 'api::article.article';

function tenantIdForSlug(slug) {
  const s = String(slug || '');
  if (/-mo2(?:-|$)/i.test(s) || /(?:^|-)mo2$/i.test(s) || s.includes('-mr-mo2')) {
    return 'mosc_malankara_orthodox_2';
  }
  return 'tenant_demo_002';
}

async function main() {
  const app = await createStrapi(await compileStrapi()).load();
  app.log.level = 'error';
  try {
    const tenants = await app.documents('api::tenant.tenant').findMany({ limit: 50 });
    const tlist = Array.isArray(tenants) ? tenants : tenants?.results || [];
    const tenantNumById = new Map();
    for (const t of tlist) {
      const row = await app.db.query('api::tenant.tenant').findOne({
        where: { documentId: t.documentId },
        select: ['id'],
      });
      if (row?.id && t.tenantId) tenantNumById.set(t.tenantId, row.id);
    }
    console.log('Tenants:', [...tenantNumById.keys()]);

    const join = getTenantJoinTable(app, ARTICLE_UID);
    const db = app.db.connection;
    const articles = await db('articles').select('id', 'document_id', 'slug', 'published_at');
    console.log('Article rows:', articles.length);

    let linked = 0;
    let skipped = 0;
    for (const row of articles) {
      const exists = await db(join.table).where({ [join.srcCol]: row.id }).first();
      if (exists) {
        skipped++;
        continue;
      }
      const tid = tenantIdForSlug(row.slug);
      const tenantNumericId = tenantNumById.get(tid);
      if (!tenantNumericId) {
        console.warn('No tenant numeric id for', tid, row.slug);
        continue;
      }
      console.log(DRY_RUN ? '[dry-run]' : 'Link', row.slug, '→', tid);
      if (!DRY_RUN) {
        await ensureTenantLinkOnRow(app, ARTICLE_UID, row.id, tenantNumericId, join);
      }
      linked++;
    }
    console.log('Done. linked=', linked, 'alreadyHadTenant=', skipped);
  } finally {
    await app.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
