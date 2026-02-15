'use strict';

/**
 * Restore publishedAt (and optionally createdAt) for Editorial Articles from a
 * Strapi export .tar file. Use this AFTER strapi import when dates were overwritten.
 *
 * Strapi import can reset publishedAt to the import date; this script reads the
 * export file and updates the database with the original dates.
 *
 * Run: node scripts/restore_article_dates_from_export.js <path-to-export.tar>
 *   or: EXPORT_TAR=my-export-1.tar node scripts/restore_article_dates_from_export.js
 *
 * Prerequisites: Strapi must be stopped (script loads Strapi to access DB).
 */

try {
  require('dotenv').config();
} catch (_) {}

const fs = require('fs');
const path = require('path');
const tarStream = require('tar-stream');

const ARTICLE_UID = 'api::article.article';

async function extractArticleDatesFromExport(tarPath) {
  if (!tarPath || !fs.existsSync(tarPath)) {
    throw new Error('Export file not found: ' + tarPath);
  }
  const articles = [];
  return new Promise((resolve, reject) => {
    const extract = tarStream.extract();
    const readStream = fs.createReadStream(tarPath);

    extract.on('entry', (header, stream, next) => {
      if (!header.name.startsWith('entities/') || !header.name.endsWith('.jsonl')) {
        stream.resume();
        next();
        return;
      }
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        const content = Buffer.concat(chunks).toString();
        for (const line of content.split('\n').filter(Boolean)) {
          try {
            const e = JSON.parse(line);
            const uid = e?.ref ?? e?.type;
            if (!e || uid !== ARTICLE_UID) continue;
            const data = e.data ?? e.attributes ?? e;
            const documentId = data.documentId ?? data.document_id;
            const slug = data.slug ?? null;
            const publishedAt = data.publishedAt ?? data.published_at;
            const createdAt = data.createdAt ?? data.created_at;
            if (documentId && publishedAt) {
              articles.push({
                documentId: String(documentId),
                slug: slug ? String(slug) : null,
                publishedAt: typeof publishedAt === 'string' ? publishedAt : (publishedAt ? new Date(publishedAt).toISOString() : null),
                createdAt: typeof createdAt === 'string' ? createdAt : (createdAt ? new Date(createdAt).toISOString() : null),
              });
            }
          } catch (_) {}
        }
        next();
      });
      stream.resume();
    });

    extract.on('finish', () => resolve(articles));
    extract.on('error', reject);
    readStream.pipe(extract);
  });
}

async function restoreDates(strapi, articles) {
  if (!articles.length) return 0;
  const db = strapi.db.connection;

  // Build map: documentId -> article. When export has duplicates (draft+published),
  // prefer the earliest publishedAt (original date; later is often the import date).
  const byDocId = new Map();
  for (const a of articles) {
    const existing = byDocId.get(a.documentId);
    if (!existing || (a.publishedAt && existing.publishedAt && a.publishedAt < existing.publishedAt)) {
      byDocId.set(a.documentId, a);
    }
  }

  // Fallback map: slug -> article (if documentIds don't match after import)
  const bySlug = new Map();
  for (const a of articles) {
    if (a.slug) {
      const existing = bySlug.get(a.slug);
      if (!existing || (a.publishedAt && existing.publishedAt && a.publishedAt < existing.publishedAt)) {
        bySlug.set(a.slug, a);
      }
    }
  }

  // Get all article rows from DB (published rows have published_at)
  const rows = await db('articles').select('id', 'document_id', 'slug', 'published_at');
  let updated = 0;

  for (const row of rows || []) {
    // Only update published rows (draft rows have published_at null)
    if (row.published_at == null) continue;
    const docId = row.document_id;
    const slug = row.slug;
    const source = byDocId.get(docId) || (slug ? bySlug.get(slug) : null);
    if (!source || !source.publishedAt) continue;

    if (row.published_at !== source.publishedAt) {
      await db('articles').where({ id: row.id }).update({
        published_at: source.publishedAt,
        updated_at: source.publishedAt,
      });
      updated++;
    }
  }

  return updated;
}

async function main() {
  const tarPath =
    process.env.EXPORT_TAR ||
    process.argv[2] ||
    path.resolve(process.cwd(), 'my-export-1.tar');

  if (!fs.existsSync(tarPath)) {
    console.error('Usage: node scripts/restore_article_dates_from_export.js <path-to-export.tar>');
    console.error('   or: EXPORT_TAR=my-export-1.tar node scripts/restore_article_dates_from_export.js');
    console.error('File not found:', tarPath);
    process.exit(1);
  }

  console.log('Reading articles from export:', tarPath);
  const articles = await extractArticleDatesFromExport(tarPath);
  console.log('Found', articles.length, 'articles with publishedAt in export.');

  if (articles.length === 0) {
    console.log('Nothing to restore.');
    process.exit(0);
  }

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  try {
    const updated = await restoreDates(app, articles);
    console.log('Restored publishedAt for', updated, 'article rows.');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await app.destroy();
  }
  process.exit(process.exitCode || 0);
}

main();
