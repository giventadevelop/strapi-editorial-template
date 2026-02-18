'use strict';

/**
 * Delete all collection-type documents on a Strapi Cloud (or remote) instance
 * so you can run the REST push script again from a clean state. Uses the same
 * env as rest_api_push_to_cloud.js.
 *
 * Use when: articles (or other entries) were pushed but relations (category,
 * tenant, author) or media (cover) are empty, and you want to start fresh and
 * re-push from export.
 *
 * Prerequisites: STRAPI_CLOUD_URL, STRAPI_CLOUD_API_TOKEN (Full Access).
 *
 * Usage:
 *   set STRAPI_CLOUD_URL=https://YOUR-PROJECT.strapiapp.com
 *   set STRAPI_CLOUD_API_TOKEN=your-token
 *   node scripts/clear_cloud_data.js
 *   Or: npm run clear:cloud-data
 *
 * Options:
 *   --types=articles,categories  Only delete these plural API IDs (comma-separated).
 *   --dry-run                    List what would be deleted, no DELETE calls.
 */

try {
  require('dotenv').config();
} catch (_) {}

const path = require('path');

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const DRY_RUN = process.argv.includes('--dry-run');
const typesArg = process.argv.find(a => a.startsWith('--types='));
const ONLY_TYPES = typesArg ? new Set(typesArg.split('=')[1].split(',').map(s => s.trim())) : null;

if (!CLOUD_URL || !API_TOKEN) {
  console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN.');
  process.exit(1);
}

const projectRoot = path.resolve(__dirname, '..');

function loadTypeToPluralAndSingleTypes() {
  const fs = require('fs');
  const typeToPlural = {};
  const singleTypes = new Set();
  const apiPath = path.join(projectRoot, 'src', 'api');
  if (!fs.existsSync(apiPath)) return { typeToPlural, singleTypes };
  const dirs = fs.readdirSync(apiPath, { withFileTypes: true }).filter(d => d.isDirectory());
  for (const dir of dirs) {
    const schemaPath = path.join(apiPath, dir.name, 'content-types', dir.name, 'schema.json');
    const altPath = path.join(apiPath, dir.name, 'content-types', path.basename(dir.name), 'schema.json');
    const p = fs.existsSync(schemaPath) ? schemaPath : altPath;
    if (!fs.existsSync(p)) continue;
    try {
      const schema = JSON.parse(fs.readFileSync(p, 'utf8'));
      const info = schema.info || {};
      const plural = info.pluralName || dir.name;
      const singular = info.singularName || dir.name;
      if (schema.kind === 'singleType') singleTypes.add(plural);
      else typeToPlural[plural] = true;
    } catch (_) {}
  }
  return { typeToPlural, singleTypes };
}

/** Delete order: types that reference others first (e.g. articles), then base types. Single types (abouts, globals, homepages) are skipped. */
const DELETE_ORDER = [
  'articles', 'flash-news-items', 'sidebar-promotional-blocks', 'advertisement-slots',
  'directory-entries', 'bishops', 'diocesan-bishops', 'retired-bishops', 'catholicos-entries',
  'church-dignitaries', 'managing-committees', 'working-committees', 'pilgrim-centres',
  'seminaries', 'spiritual-organisations', 'institutions', 'churches', 'parishes',
  'dioceses', 'priests', 'directory-homes',
  'authors', 'categories', 'tenants', 'editor-tenants',
];

async function fetchAllDocumentIds(plural) {
  const ids = [];
  let page = 1;
  const pageSize = 100;
  while (true) {
    const url = `${CLOUD_URL}/api/${plural}?pagination[page]=${page}&pagination[pageSize]=${pageSize}`;
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
  const url = `${CLOUD_URL}/api/${plural}/${documentId}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  return res.ok;
}

async function main() {
  const { typeToPlural, singleTypes } = loadTypeToPluralAndSingleTypes();
  const collectionPlurals = Object.keys(typeToPlural);
  const inOrder = ONLY_TYPES
    ? DELETE_ORDER.filter(p => ONLY_TYPES.has(p) && collectionPlurals.includes(p))
    : DELETE_ORDER.filter(p => collectionPlurals.includes(p));
  const rest = collectionPlurals.filter(p => !inOrder.includes(p));
  const order = [...inOrder, ...rest];

  if (order.length === 0) {
    console.log('No collection types to clear (or --types= did not match any).');
    return;
  }

  console.log(DRY_RUN ? '[DRY RUN] Would clear types:' : 'Clearing collection types (delete order):', order.join(', '));
  console.log('');

  let totalDeleted = 0;
  for (const plural of order) {
    const ids = await fetchAllDocumentIds(plural);
    if (ids.length === 0) {
      console.log(plural + ': 0 documents');
      continue;
    }
    if (DRY_RUN) {
      console.log(plural + ':', ids.length, 'documents (would delete)');
      totalDeleted += ids.length;
      continue;
    }
    let ok = 0;
    for (const id of ids) {
      const deleted = await deleteDocument(plural, id);
      if (deleted) ok++;
    }
    console.log(plural + ':', ok + '/' + ids.length, 'deleted');
    totalDeleted += ok;
  }

  console.log('\nDone. Total documents deleted:', totalDeleted);
  console.log('You can now run: npm run push:rest-to-cloud -- your-export.tar.gz');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
