'use strict';

/**
 * Fix article category and tenant: propagate existing links to ALL article rows
 * (draft + published). Run this if category and tenant show in published view
 * but are empty in the Content Manager (which loads the draft by default).
 *
 * Run: node scripts/fix_article_category_tenant.js
 */

try {
  require('dotenv').config();
} catch (_) {}

async function syncCategoryAndTenantToAllArticleRows(strapi) {
  const db = strapi.db.connection;
  try {
    const catLinks = await db('articles_category_lnk').select('article_id', 'category_id');
    const tenantLinks = await db('articles_tenant_lnk').select('article_id', 'tenant_id');
    const byArticleId = new Map();
    for (const row of catLinks || []) {
      const art = await db('articles').where({ id: row.article_id }).select('document_id').first();
      if (art?.document_id) byArticleId.set(art.document_id, { ...(byArticleId.get(art.document_id) || {}), category_id: row.category_id });
    }
    for (const row of tenantLinks || []) {
      const art = await db('articles').where({ id: row.article_id }).select('document_id').first();
      if (art?.document_id) byArticleId.set(art.document_id, { ...(byArticleId.get(art.document_id) || {}), tenant_id: row.tenant_id });
    }
    let added = 0;
    for (const [docId, refs] of byArticleId) {
      const { category_id, tenant_id } = refs;
      if (!category_id && !tenant_id) continue;
      const allRows = await db('articles').where({ document_id: docId }).select('id');
      for (const row of allRows || []) {
        if (category_id) {
          const exists = await db('articles_category_lnk').where({ article_id: row.id }).first();
          if (!exists) {
            await db('articles_category_lnk').insert({ article_id: row.id, category_id, article_ord: 1 });
            added++;
          }
        }
        if (tenant_id) {
          const exists = await db('articles_tenant_lnk').where({ article_id: row.id }).first();
          if (!exists) {
            await db('articles_tenant_lnk').insert({ article_id: row.id, tenant_id });
            added++;
          }
        }
      }
    }
    return added;
  } catch (err) {
    strapi.log.warn('Could not sync category/tenant:', err.message);
    return 0;
  }
}

async function main() {
  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  try {
    const added = await syncCategoryAndTenantToAllArticleRows(app);
    console.log('Propagated category/tenant to', added, 'additional article rows.');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await app.destroy();
  }
  process.exit(process.exitCode || 0);
}

main();
