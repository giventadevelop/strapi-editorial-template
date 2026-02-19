'use strict';

/**
 * Keep only 5 records per content type for: Parish, Diocese, Bishops, Priests, Articles.
 * Deletes all other documents for those types.
 *
 * Target:
 *   --local   Use local Strapi (STRAPI_LOCAL_URL, STRAPI_LOCAL_API_TOKEN). Default URL: http://localhost:1337
 *   --remote  Use remote/Cloud (STRAPI_CLOUD_URL, STRAPI_CLOUD_API_TOKEN). This is the default if no flag.
 *
 * Usage (remote/Cloud):
 *   set STRAPI_CLOUD_URL=https://YOUR-PROJECT.strapiapp.com
 *   set STRAPI_CLOUD_API_TOKEN=your-token
 *   node scripts/cloud_keep_five.js
 *   Or: npm run cloud:keep-five
 *
 * Usage (local):
 *   set STRAPI_LOCAL_URL=http://localhost:1337
 *   set STRAPI_LOCAL_API_TOKEN=your-full-access-token
 *   node scripts/cloud_keep_five.js --local
 *   Or: npm run cloud:keep-five -- --local
 *
 * Options:
 *   --dry-run   List what would be kept/deleted, no DELETE calls.
 */

try {
  require('dotenv').config();
} catch (_) {}

const path = require('path');

const USE_LOCAL = process.argv.includes('--local');
const USE_REMOTE = process.argv.includes('--remote');
const target = USE_LOCAL ? 'local' : (USE_REMOTE ? 'remote' : 'remote');

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const CLOUD_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const LOCAL_URL = (process.env.STRAPI_LOCAL_URL || 'http://localhost:1337').replace(/\/$/, '');
const LOCAL_TOKEN = process.env.STRAPI_LOCAL_API_TOKEN || '';

const BASE_URL = target === 'local' ? LOCAL_URL : CLOUD_URL;
const API_TOKEN = target === 'local' ? LOCAL_TOKEN : CLOUD_TOKEN;

const DRY_RUN = process.argv.includes('--dry-run');
const KEEP = 5;

const PLURALS = ['parishes', 'dioceses', 'bishops', 'priests', 'articles'];

if (!BASE_URL || !API_TOKEN) {
  if (target === 'local') {
    console.error('For --local set STRAPI_LOCAL_URL (default http://localhost:1337) and STRAPI_LOCAL_API_TOKEN (Full Access token from local Strapi admin).');
  } else {
    console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN (or use --local for local instance).');
  }
  process.exit(1);
}

async function fetchAllDocumentIds(plural) {
  const ids = [];
  let page = 1;
  const pageSize = 100;
  while (true) {
    const url = `${BASE_URL}/api/${plural}?pagination[page]=${page}&pagination[pageSize]=${pageSize}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${API_TOKEN}` } });
    if (!res.ok) {
      console.warn(`GET ${plural} page ${page}: ${res.status}`);
      break;
    }
    const json = await res.json();
    const data = json?.data;
    const list = Array.isArray(data) ? data : (data ? [data] : []);
    for (const doc of list) {
      const id = doc.documentId ?? doc.id;
      if (id) ids.push(id);
    }
    if (list.length < pageSize) break;
    page++;
  }
  return ids;
}

async function deleteDocument(plural, documentId) {
  const url = `${BASE_URL}/api/${plural}/${documentId}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  return res.ok;
}

async function main() {
  console.log('Target:', target === 'local' ? 'LOCAL' : 'REMOTE (Cloud)', '-', BASE_URL);
  console.log(DRY_RUN ? '[DRY RUN] Keep' : 'Keep', KEEP, 'records per type; delete the rest for:', PLURALS.join(', '));
  console.log('');

  let totalDeleted = 0;
  for (const plural of PLURALS) {
    const ids = await fetchAllDocumentIds(plural);
    if (ids.length === 0) {
      console.log(plural + ': 0 documents');
      continue;
    }
    const toKeep = ids.slice(0, KEEP);
    const toDelete = ids.slice(KEEP);
    if (DRY_RUN) {
      console.log(plural + ':', ids.length, 'total → keep', toKeep.length, ', would delete', toDelete.length);
      totalDeleted += toDelete.length;
      continue;
    }
    let ok = 0;
    for (const id of toDelete) {
      const deleted = await deleteDocument(plural, id);
      if (deleted) ok++;
    }
    console.log(plural + ':', ids.length, 'total → kept', toKeep.length, ', deleted', ok + '/' + toDelete.length);
    totalDeleted += ok;
  }

  console.log('\nDone. Total documents deleted:', totalDeleted);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
