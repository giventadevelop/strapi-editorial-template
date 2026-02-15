'use strict';

/**
 * Inspect the structure of entities in a Strapi export .tar file.
 * Use this to diagnose restore_article_dates_from_export issues.
 *
 * Run: node scripts/inspect_export_entities.js <path-to-export.tar>
 */

try {
  require('dotenv').config();
} catch (_) {}

const fs = require('fs');
const path = require('path');
const tarStream = require('tar-stream');

async function inspect(tarPath) {
  if (!tarPath || !fs.existsSync(tarPath)) {
    console.error('File not found:', tarPath);
    process.exit(1);
  }
  const sampleLines = [];
  let totalLines = 0;
  let articleLikeLines = 0;

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
        const lines = content.split('\n').filter(Boolean);
        totalLines += lines.length;
        for (let i = 0; i < lines.length; i++) {
          try {
            const e = JSON.parse(lines[i]);
            const ref = e?.ref ?? e?.type;
            if (ref && String(ref).toLowerCase().includes('article')) {
              articleLikeLines++;
              if (sampleLines.length < 3) sampleLines.push({ line: i + 1, parsed: e });
            }
          } catch (_) {}
        }
        next();
      });
      stream.resume();
    });

    extract.on('finish', () => {
      console.log('Entities file: total lines =', totalLines);
      console.log('Article-like lines (ref/type contains "article"):', articleLikeLines);
      console.log('\nSample article entity lines (first 3):');
      sampleLines.forEach((s, i) => {
        console.log('\n--- Sample', i + 1, '(line', s.line, ') ---');
        const p = s.parsed || {};
        console.log('Top-level keys:', Object.keys(p));
        console.log('ref:', p.ref, '| type:', p.type);
        const data = p.data ?? p.attributes ?? p;
        console.log('data/attributes keys:', Object.keys(data || {}));
        if (data) {
          console.log('  documentId:', data.documentId ?? data.document_id);
          console.log('  slug:', data.slug);
          console.log('  publishedAt:', data.publishedAt ?? data.published_at);
        }
      });
      resolve();
    });
    extract.on('error', reject);
    readStream.pipe(extract);
  });
}

const tarPath = process.env.EXPORT_TAR || process.argv[2] || path.resolve(process.cwd(), 'my-export-1.tar');
inspect(tarPath).catch((err) => {
  console.error(err);
  process.exit(1);
});
