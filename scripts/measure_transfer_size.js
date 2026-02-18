'use strict';

/**
 * Measure approximate transfer payload size by running a Strapi export
 * (same data as transfer: entities, links, config; no asset bytes if using S3).
 * Creates transfer-size-check.tar.gz in project root and prints its size.
 *
 * Usage: node scripts/measure_transfer_size.js
 * Or:    npm run measure:transfer-size
 *
 * Requires Strapi to be installed (npm run strapi export). Run from project root.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const exportName = 'transfer-size-check';
const projectRoot = path.resolve(__dirname, '..');
const tarGz = path.join(projectRoot, `${exportName}.tar.gz`);
const tar = path.join(projectRoot, `${exportName}.tar`);

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(2) + ' KB';
  return bytes + ' B';
}

function main() {
  console.log('Running strapi export (no encryption) to measure payload size...');
  console.log('This is the same data that would be streamed during transfer with --exclude files.\n');

  try {
    execSync(`npm run strapi export -- --no-encrypt -f ${exportName}`, {
      cwd: projectRoot,
      stdio: 'inherit',
    });
  } catch (err) {
    console.error('Export failed. Run manually: npm run strapi export -- --no-encrypt -f', exportName);
    process.exit(1);
  }

  let file = tarGz;
  if (!fs.existsSync(tarGz)) file = tar;
  if (!fs.existsSync(file)) {
    console.error('Export did not create', tarGz, 'or', tar);
    process.exit(1);
  }

  const stat = fs.statSync(file);
  const size = stat.size;
  console.log('\n--- Transfer size estimate ---');
  console.log('File:', path.basename(file));
  console.log('Size:', formatBytes(size), '(' + size + ' bytes)');
  console.log('\nThis approximates the data streamed during: npm run strapi transfer -- --to <URL> --exclude files');
  console.log('You can delete the file after checking: del "' + file + '"');
}

main();
