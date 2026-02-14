'use strict';

/**
 * Delete all Article entries.
 * Use for a clean slate before re-running the news import (e.g. to fix tenant mapping).
 * Categories are not deleted (they may be shared across tenants).
 *
 * Run from project root: node scripts/delete_articles.js
 * Optional: DRY_RUN=1 to only list counts and skip deletion.
 */

try {
  require('dotenv').config();
} catch (_) {}

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const ARTICLE_UID = 'api::article.article';
const LABEL = 'Articles';

async function getDocumentIds(strapi, uid) {
  const rows = await strapi.db.query(uid).findMany({
    select: ['id', 'documentId', 'document_id'],
  });
  return (rows || []).map((r) => r.documentId ?? r.document_id ?? r.id).filter(Boolean);
}

async function deleteAllArticles(strapi) {
  const docIds = await getDocumentIds(strapi, ARTICLE_UID);
  const count = docIds.length;
  if (count === 0) {
    console.log(LABEL + ': 0 entries (skip)');
    return;
  }
  if (DRY_RUN) {
    console.log(LABEL + ':', count, 'entries (DRY_RUN – not deleted)');
    return;
  }
  let deleted = 0;
  for (const documentId of docIds) {
    try {
      await strapi.documents(ARTICLE_UID).delete({ documentId });
      deleted++;
    } catch (e) {
      console.warn('  Delete failed:', documentId, e.message);
    }
  }
  console.log(LABEL + ':', deleted, 'deleted');
}

async function main() {
  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  try {
    if (DRY_RUN) console.log('DRY RUN – no data will be deleted.\n');
    await deleteAllArticles(app);
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
