'use strict';

/**
 * Fix article cover images: propagate existing cover links to ALL article rows
 * (draft + published). Run this if covers show in some views but not in the
 * Content Manager edit view (which loads the draft by default).
 *
 * Run: node scripts/fix_article_covers.js
 */

try {
  require('dotenv').config();
} catch (_) {}

async function syncCoverToAllArticleRows(strapi) {
  const db = strapi.db.connection;
  const morphTable = 'files_related_mph';
  const uid = 'api::article.article';
  try {
    const morphRows = await db(morphTable)
      .where({ related_type: uid, field: 'cover' })
      .select('related_id', 'file_id');
    const byDoc = new Map();
    for (const m of morphRows || []) {
      const art = await db('articles').where({ id: m.related_id }).select('document_id').first();
      const docId = art?.document_id;
      if (!docId) continue;
      if (!byDoc.has(docId)) byDoc.set(docId, m.file_id);
    }
    let added = 0;
    for (const [docId, fileId] of byDoc) {
      const allRows = await db('articles').where({ document_id: docId }).select('id');
      for (const row of allRows || []) {
        const existing = await db(morphTable)
          .where({ related_id: row.id, related_type: uid, field: 'cover' })
          .first();
        if (!existing) {
          await db(morphTable).insert({
            file_id: fileId,
            related_id: row.id,
            related_type: uid,
            field: 'cover',
            order: 1,
          });
          added++;
        }
      }
    }
    return added;
  } catch (err) {
    strapi.log.warn('Could not sync cover:', err.message);
    return 0;
  }
}

async function main() {
  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  try {
    const added = await syncCoverToAllArticleRows(app);
    console.log('Propagated cover to', added, 'additional article rows.');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await app.destroy();
  }
  process.exit(process.exitCode || 0);
}

main();
