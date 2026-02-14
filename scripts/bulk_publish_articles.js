'use strict';

/**
 * Bulk publish all Article entries that are currently drafts (publishedAt is null).
 * Optional: TENANT_ID to limit to a specific tenant (e.g. tenant_demo_002).
 * DRY_RUN=1 to only list counts without publishing.
 *
 * Run from project root: node scripts/bulk_publish_articles.js
 */

try {
  require('dotenv').config();
} catch (_) {}

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const TENANT_ID = process.env.TENANT_ID || null;

const ARTICLE_UID = 'api::article.article';

async function bulkPublishArticles(strapi) {
  const where = { publishedAt: null };
  if (TENANT_ID) {
    const tenant = await strapi.db.query('api::tenant.tenant').findOne({
      where: { tenantId: TENANT_ID },
      select: ['id'],
    });
    if (!tenant) {
      console.log('Tenant not found:', TENANT_ID);
      return;
    }
    where.tenant = tenant.id;
  }
  const rows = await strapi.db.query(ARTICLE_UID).findMany({
    where,
    select: ['id'],
  });
  const count = (rows || []).length;
  if (count === 0) {
    console.log('No draft articles found' + (TENANT_ID ? ` for tenant ${TENANT_ID}` : '') + '.');
    return;
  }
  if (DRY_RUN) {
    console.log(count, 'draft articles would be published (DRY_RUN – no changes).');
    return;
  }
  const now = new Date().toISOString();
  const db = strapi.db.connection;
  const table = 'articles';
  let published = 0;
  for (const row of rows || []) {
    try {
      await db(table).where({ id: row.id }).update({
        published_at: now,
        updated_at: now,
      });
      published++;
    } catch (e) {
      console.warn('  Publish failed (id:', row.id, '):', e.message);
    }
  }
  console.log('Published', published, 'articles.');
}

async function main() {
  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  try {
    if (DRY_RUN) console.log('DRY RUN – no articles will be published.\n');
    if (TENANT_ID) console.log('Filtering by tenant:', TENANT_ID);
    await bulkPublishArticles(app);
    console.log('\nDone.');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await app.destroy();
  }
  process.exit(process.exitCode || 0);
}

main();
