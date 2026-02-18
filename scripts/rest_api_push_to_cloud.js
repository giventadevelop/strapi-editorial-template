'use strict';

/**
 * Batched REST API push: push Strapi export data to a remote (e.g. Strapi Cloud)
 * via the Content API instead of strapi transfer. Bypasses WebSocket; each batch
 * is an independent HTTP request with retry. See documentation §10.1.5.
 *
 * Prerequisites:
 *   - Full Access API token on the destination (Settings → API Tokens).
 *   - Export file: npm run strapi export -- --no-encrypt -f my-export
 *   - Destination has same schemas (deploy code first).
 *
 * Usage:
 *   STRAPI_CLOUD_URL=https://YOUR-PROJECT.strapiapp.com STRAPI_CLOUD_API_TOKEN=xxx node scripts/rest_api_push_to_cloud.js [path-to-export.tar.gz]
 *   Or: npm run push:rest-to-cloud -- [path-to-export.tar.gz]
 *
 * Env:
 *   STRAPI_CLOUD_URL     – base URL of the destination (no trailing slash).
 *   STRAPI_CLOUD_API_TOKEN – Full Access API token.
 *   REST_PUSH_BATCH_SIZE – optional, default 20.
 *   REST_PUSH_RETRY_LIMIT – optional, default 3.
 *   REST_PUSH_DELAY_MS   – optional, ms between requests (default 0).
 *   REST_PUSH_DRY_RUN    – set to 1 to only parse and log, no HTTP.
 *   REST_PUSH_INCLUDE_UPLOADS – set to 1 to push upload (media) files from export so cover/image
 *     relations can be linked. Script fetches each file from its URL (e.g. S3) and POSTs to
 *     /api/upload on Cloud. Default: 1. Set to 0 to skip (cover will stay empty).
 */

try {
  require('dotenv').config();
} catch (_) {}

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createGunzip } = zlib;
const tarStream = require('tar-stream');

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const BATCH_SIZE = Math.max(1, parseInt(process.env.REST_PUSH_BATCH_SIZE || '20', 10));
const RETRY_LIMIT = Math.max(1, parseInt(process.env.REST_PUSH_RETRY_LIMIT || '3', 10));
const RETRY_DELAY_MS = 2000;
const DELAY_BETWEEN_REQUESTS_MS = Math.max(0, parseInt(process.env.REST_PUSH_DELAY_MS || '0', 10));
const DRY_RUN = process.env.REST_PUSH_DRY_RUN === '1' || process.env.REST_PUSH_DRY_RUN === 'true';
const INCLUDE_UPLOADS = process.env.REST_PUSH_INCLUDE_UPLOADS !== '0';

if (!CLOUD_URL || !API_TOKEN) {
  console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN (Full Access token on destination).');
  process.exit(1);
}

const projectRoot = path.resolve(__dirname, '..');

function loadTypeToPluralAndSingleTypes() {
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
      const uid = `api::${singular}.${singular}`;
      typeToPlural[uid] = plural;
      if (schema.kind === 'singleType') singleTypes.add(uid);
    } catch (_) {}
  }
  return { typeToPlural, singleTypes };
}

function isRelationValue(v) {
  if (v == null) return false;
  if (typeof v === 'object' && v !== null && 'documentId' in v) return true;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null && 'documentId' in v[0]) return true;
  return false;
}

function extractRelationDocIds(v) {
  if (v == null) return [];
  if (typeof v === 'object' && v !== null && v.documentId) return [v.documentId];
  if (Array.isArray(v)) return v.map(x => x && x.documentId).filter(Boolean);
  return [];
}

const STRIP_KEYS_FOR_API = new Set(['documentId', 'id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'localizations', 'locale']);

function sanitizeForApi(obj) {
  if (obj == null) return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeForApi);
  if (typeof obj !== 'object' || obj instanceof Date) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (STRIP_KEYS_FOR_API.has(k)) continue;
    out[k] = sanitizeForApi(v);
  }
  return out;
}

function stripRelationsForPhase1(data) {
  const plain = {};
  const relations = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (isRelationValue(v)) {
      relations[k] = v;
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date)) {
      const sub = stripRelationsForPhase1(v);
      if (Object.keys(sub.relations || {}).length) {
        relations[k] = sub.relations;
        if (Object.keys(sub.plain).length) plain[k] = sub.plain;
      } else {
        plain[k] = sub.plain;
      }
    } else {
      plain[k] = v;
    }
  }
  return { plain, relations };
}

function buildConnectPayload(relationValue, docIdMap) {
  const ids = extractRelationDocIds(relationValue);
  const mapped = ids.map(id => docIdMap.get(id)).filter(Boolean);
  if (mapped.length === 0) return undefined;
  return { connect: mapped.map(documentId => ({ documentId })) };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, logPrefix) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_LIMIT; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_TOKEN}`,
          ...options.headers,
        },
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      return text ? JSON.parse(text) : {};
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_LIMIT) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
        console.warn(`${logPrefix} retry ${attempt + 1}/${RETRY_LIMIT} in ${delay}ms: ${err.message}`);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

/** GET existing document by slug; returns documentId or null. Used when POST fails with "must be unique". */
async function findExistingBySlug(baseUrl, plural, slug) {
  if (!slug) return null;
  const encoded = encodeURIComponent(slug);
  const url = `${baseUrl}/api/${plural}?filters[slug][$eq]=${encoded}&pagination[pageSize]=1`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const first = Array.isArray(json?.data) ? json.data[0] : json?.data;
    return first?.documentId ?? null;
  } catch (_) {
    return null;
  }
}

function extractEntitiesAndLinksFromExport(exportPath, typeToPlural, singleTypes) {
  return new Promise((resolve, reject) => {
    const entitiesByType = {};
    const entityMeta = []; // { type, ref, relations } for phase 2
    const singleTypeData = {}; // type -> single document data + relationFields
    const uploadFiles = []; // { ref, url, name } from plugin::upload.file (S3 URLs in export)

    let readStream = fs.createReadStream(exportPath);
    if (exportPath.endsWith('.gz')) {
      readStream = readStream.pipe(createGunzip());
    }
    const extract = tarStream.extract();

    extract.on('entry', (header, stream, next) => {
      const name = header.name;
      if (!name.startsWith('entities/') || !name.endsWith('.jsonl')) {
        stream.resume();
        next();
        return;
      }
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        const content = Buffer.concat(chunks).toString();
        const lines = content.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const row = JSON.parse(line);
            const type = row.type || row.ref;
            const ref = row.ref ?? row.data?.documentId ?? row.documentId;
            const data = row.data ?? row.attributes ?? row;
            if (!type || typeof type !== 'string') continue;
            if (type === 'plugin::upload.file') {
              const url = data?.url;
              if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
                let baseName = data?.name;
                if (!baseName) {
                  try {
                    baseName = path.basename(new URL(url).pathname) || 'file';
                  } catch (_) {
                    baseName = 'file';
                  }
                }
                uploadFiles.push({ ref, url, name: baseName, data });
              }
              continue;
            }
            if (!typeToPlural[type]) continue;
            const { plain, relations } = stripRelationsForPhase1(data);
            if (singleTypes.has(type)) {
              singleTypeData[type] = { plain, relations, ref };
            } else {
              if (!entitiesByType[type]) entitiesByType[type] = [];
              entitiesByType[type].push({ ref, plain, relations });
              entityMeta.push({ type, ref, relations });
            }
          } catch (_) {}
        }
        next();
      });
      stream.resume();
    });

    extract.on('finish', () => resolve({ entitiesByType, entityMeta, singleTypeData, uploadFiles }));
    extract.on('error', reject);
    readStream.pipe(extract);
  });
}

async function main() {
  const exportPath = process.argv[2] || process.env.EXPORT_FILE || path.join(projectRoot, 'my-export.tar.gz');
  const altPath = exportPath.replace(/\.gz$/, '');
  const resolved = fs.existsSync(exportPath) ? exportPath : (fs.existsSync(altPath) ? altPath : null);
  if (!resolved) {
    console.error('Export file not found:', exportPath);
    console.error('Create one with: npm run strapi export -- --no-encrypt -f my-export');
    process.exit(1);
  }

  const { typeToPlural, singleTypes } = loadTypeToPluralAndSingleTypes();
  console.log('Loaded', Object.keys(typeToPlural).length, 'content types from project schema.');
  if (DRY_RUN) console.log('DRY RUN – no HTTP requests will be made.\n');

  console.log('Reading export:', resolved);
  const { entitiesByType, entityMeta, singleTypeData, uploadFiles } = await extractEntitiesAndLinksFromExport(resolved, typeToPlural, singleTypes);

  const docIdMap = new Map(); // old ref/documentId -> new documentId from Cloud

  // Phase 0: push upload (media) files from export so cover/image relations can be linked.
  // Export contains plugin::upload.file with data.url (e.g. S3). We fetch from URL and POST to /api/upload.
  if (INCLUDE_UPLOADS && uploadFiles.length > 0) {
    console.log('\nPhase 0: pushing', uploadFiles.length, 'upload file(s) from export URLs (e.g. S3)...');
    let uploadOk = 0;
    for (let i = 0; i < uploadFiles.length; i++) {
      const file = uploadFiles[i];
      if (DRY_RUN) {
        console.log('[dry-run] upload', file.name, file.url.slice(0, 60) + '...');
        uploadOk++;
        continue;
      }
      try {
        const res = await fetch(file.url, { redirect: 'follow' });
        if (!res.ok) throw new Error(`Fetch ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const form = new FormData();
        form.append('files', new Blob([new Uint8Array(buf)]), file.name);
        const uploadRes = await fetch(`${CLOUD_URL}/api/upload`, {
          method: 'POST',
          body: form,
          headers: { Authorization: `Bearer ${API_TOKEN}` },
        });
        if (!uploadRes.ok) {
          const text = await uploadRes.text();
          throw new Error(`Upload ${uploadRes.status}: ${text.slice(0, 150)}`);
        }
        const uploadJson = await uploadRes.json();
        const raw = Array.isArray(uploadJson) ? uploadJson[0] : uploadJson;
        const created = raw?.data ?? raw;
        const newId = created?.documentId ?? created?.id ?? raw?.documentId ?? raw?.id;
        if (newId) docIdMap.set(file.ref, newId);
        uploadOk++;
        if ((i + 1) % 25 === 0) console.log('  uploads', i + 1 + '/' + uploadFiles.length);
      } catch (err) {
        console.warn('✖ upload', file.name, file.ref, err.message);
      }
    }
    console.log('✓ uploads', uploadOk + '/' + uploadFiles.length);
  } else if (uploadFiles.length > 0 && !INCLUDE_UPLOADS) {
    console.log('\nSkipping', uploadFiles.length, 'upload files (REST_PUSH_INCLUDE_UPLOADS=0). Cover/image will stay empty.');
  }

  const api = (plural, documentId = null) => {
    const base = `${CLOUD_URL}/api/${plural}`;
    return documentId ? `${base}/${documentId}` : base;
  };

  // Phase 1a: single types (POST to create; Strapi 5 uses POST for create, PUT /:documentId for update)
  for (const [type, one] of Object.entries(singleTypeData)) {
    const plural = typeToPlural[type];
    if (!plural) continue;
    if (DRY_RUN) {
      console.log('[dry-run] POST', plural, '(single type)');
      continue;
    }
    const payload = sanitizeForApi(one.plain);
    try {
      const res = await fetchWithRetry(api(plural), {
        method: 'POST',
        body: JSON.stringify({ data: payload }),
      }, `POST ${plural}`);
      const newId = res?.data?.documentId;
      if (newId && one.ref) docIdMap.set(one.ref, newId);
      console.log('✓', plural, '(single type)');
    } catch (err) {
      if (err.message.includes('405')) {
        console.warn('⚠', plural, '(single type): not writable via Content API on this instance; create/update in Cloud admin if needed.');
      } else {
        console.error('✖', plural, err.message);
      }
    }
  }

  // Phase 1b: collection types (POST per entry, in batches). Push in dependency order so
  // category, author, tenant exist before articles — phase 2 needs their documentIds in the map.
  const PUSH_FIRST = ['tenants', 'editor-tenants', 'categories', 'authors', 'dioceses', 'parishes', 'churches'];
  const typeList = Object.keys(entitiesByType);
  const typesOrder = [
    ...typeList.filter(t => PUSH_FIRST.includes(typeToPlural[t])),
    ...typeList.filter(t => !PUSH_FIRST.includes(typeToPlural[t])),
  ];
  for (const type of typesOrder) {
    const list = entitiesByType[type];
    const plural = typeToPlural[type];
    if (!plural || !list.length) continue;
    const totalBatches = Math.ceil(list.length / BATCH_SIZE);
    for (let b = 0; b < totalBatches; b++) {
      const start = b * BATCH_SIZE;
      const batch = list.slice(start, start + BATCH_SIZE);
      const batchNum = b + 1;
      if (DRY_RUN) {
        console.log(`[dry-run] ${plural} batch ${batchNum}/${totalBatches} (${batch.length} entries)`);
        continue;
      }
      let ok = 0;
      for (let i = 0; i < batch.length; i++) {
        if (DELAY_BETWEEN_REQUESTS_MS > 0 && i > 0) await sleep(DELAY_BETWEEN_REQUESTS_MS);
        const { ref, plain } = batch[i];
        const payload = sanitizeForApi(plain);
        try {
          const res = await fetchWithRetry(api(plural), {
            method: 'POST',
            body: JSON.stringify({ data: payload }),
          }, `${plural} batch ${batchNum} entry ${i + 1}`);
          const newId = res?.data?.documentId;
          if (newId) docIdMap.set(ref, newId);
          ok++;
        } catch (err) {
          const isUniqueError = /unique|must be unique/i.test(err.message);
          if (isUniqueError && payload.slug) {
            const existingId = await findExistingBySlug(CLOUD_URL, plural, payload.slug);
            if (existingId) {
              docIdMap.set(ref, existingId);
              ok++;
            } else {
              console.error(`✖ ${plural} batch ${batchNum} entry ${i + 1} (ref ${ref}):`, err.message);
            }
          } else {
            console.error(`✖ ${plural} batch ${batchNum} entry ${i + 1} (ref ${ref}):`, err.message);
          }
        }
      }
      console.log(`✓ ${plural} batch ${batchNum}/${totalBatches} (${ok}/${batch.length} entries)`);
    }
  }

  // Phase 2: restore relations (PATCH)
  const withRelations = entityMeta.filter(m => m.relations && Object.keys(m.relations).length > 0);
  if (withRelations.length > 0 && !DRY_RUN) {
    console.log('\nPhase 2: restoring relations for', withRelations.length, 'entities...');
    for (const { type, ref, relations } of withRelations) {
      const newDocId = docIdMap.get(ref);
      if (!newDocId) continue;
      const plural = typeToPlural[type];
      if (!plural) continue;
      const connectPayload = {};
      for (const [field, value] of Object.entries(relations)) {
        const conn = buildConnectPayload(value, docIdMap);
        if (conn) connectPayload[field] = conn;
      }
      if (Object.keys(connectPayload).length === 0) continue;
      try {
        await fetchWithRetry(api(plural, newDocId), {
          method: 'PUT',
          body: JSON.stringify({ data: connectPayload }),
        }, `PATCH ${type} ${newDocId}`);
      } catch (err) {
        console.warn(`Relation patch failed for ${type} ${ref}:`, err.message);
      }
    }
    console.log('✓ relations phase done.');
  }

  console.log('\nDone. documentId map size:', docIdMap.size);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
