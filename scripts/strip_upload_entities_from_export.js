'use strict';

/**
 * Remove plugin::upload.file entities from a Strapi export archive.
 * Use when your export includes 16k+ upload records that only cause 403 on asset read
 * and you don't need them (e.g. media is on S3 and you'll push content without re-uploading).
 *
 * Reads the export tar.gz, rewrites entities/*.jsonl to drop every line whose type is
 * plugin::upload.file, and writes a new archive. All other entries (schemas, links,
 * configuration, other entities) are copied unchanged.
 *
 * Usage:
 *   node scripts/strip_upload_entities_from_export.js my-export-5-records.tar.gz
 *   Or: npm run export:strip-uploads -- my-export-5-records.tar.gz
 *
 * Output: <name>.no-uploads.tar.gz (input is not modified).
 *
 * Note: The 403 still occurs during the original export (when Strapi reads asset bytes).
 * This script only rewrites the resulting archive so it no longer contains upload.file
 * entities. Use the .no-uploads.tar.gz for REST push or import; cover/image relations
 * will be empty unless you re-upload media another way.
 */

const fs = require('fs');
const zlib = require('zlib');
const { createGunzip } = zlib;
const tarStream = require('tar-stream');

function main() {
  const inputPath = process.argv[2] || process.env.EXPORT_FILE;
  if (!inputPath || !fs.existsSync(inputPath)) {
    console.error('Usage: node scripts/strip_upload_entities_from_export.js <export.tar.gz>');
    console.error('  Or set EXPORT_FILE and run again.');
    process.exit(1);
  }

  const base = inputPath.replace(/\.(tar\.gz|tar)$/i, '');
  const outputPath = base + '.no-uploads.tar.gz';
  if (outputPath === inputPath) {
    console.error('Refusing to overwrite input. Use a path that does not equal output.');
    process.exit(1);
  }

  const extract = tarStream.extract();
  const pack = tarStream.pack();

  pack.pipe(zlib.createGzip()).pipe(fs.createWriteStream(outputPath)).on('finish', () => {
    console.log('Written:', outputPath);
  });

  extract.on('entry', (header, stream, next) => {
    const name = header.name;
    const isEntitiesJsonl = name.startsWith('entities/') && name.endsWith('.jsonl');

    if (!isEntitiesJsonl) {
      stream.pipe(pack.entry(header, next));
      return;
    }

    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => {
      const content = Buffer.concat(chunks).toString();
      const lines = content.split('\n').filter(Boolean);
      let kept = 0;
      let dropped = 0;
      const filtered = lines.filter(line => {
        try {
          const row = JSON.parse(line);
          const type = row.type || row.ref;
          if (type === 'plugin::upload.file') {
            dropped++;
            return false;
          }
          kept++;
          return true;
        } catch (_) {
          kept++;
          return true;
        }
      });
      const newContent = filtered.join('\n') + (filtered.length ? '\n' : '');
      pack.entry({ name, size: Buffer.byteLength(newContent) }, newContent, next);
      if (dropped > 0) {
        console.log(name + ':', 'dropped', dropped, 'plugin::upload.file, kept', kept);
      }
    });
    stream.resume();
  });

  extract.on('finish', () => pack.finalize());
  extract.on('error', err => {
    console.error(err);
    process.exit(1);
  });

  let readStream = fs.createReadStream(inputPath);
  if (inputPath.endsWith('.gz')) {
    readStream = readStream.pipe(createGunzip());
  }
  readStream.pipe(extract);
}

main();
