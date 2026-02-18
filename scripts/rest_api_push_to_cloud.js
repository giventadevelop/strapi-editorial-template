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
 *   REST_PUSH_INCLUDE_UPLOADS – set to 1 to push upload (media) so cover/image can be linked.
 *     Default: 1. Set to 0 to skip (cover/image will stay empty).
 *
 *   What happens when uploads are included (REST_PUSH_INCLUDE_UPLOADS=1):
 *   - Default (reupload): The script FETCHES each file from the export URL (e.g. S3) and POSTs
 *     the file bytes to Cloud /api/upload. So it is a physical re-upload: S3 -> script -> Cloud.
 *     Cloud then stores the file (in its storage or in S3 if Cloud is configured to use S3).
 *   - Strapi's public API has no "create media entry with URL only" endpoint; /api/upload only
 *     accepts multipart file uploads. So "just associating the existing S3 URL" without
 *     transferring the file is not supported by Strapi out of the box. To do that you would need
 *     a custom endpoint on Cloud that creates the upload document with the S3 URL.
 *
 * Images / S3: In reupload mode the script fetches from export URLs (often S3). Those URLs must be readable
 * (e.g. bucket policy allowing GetObject, or public read). The ACL fix in config/env only affects
 * Strapi’s upload to S3, not this script’s fetch from S3.
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

/** Treat object with documentId or id as relation (Strapi export may use either). */
function isRelationValue(v) {
  if (v == null) return false;
  if (typeof v === 'object' && v !== null && ('documentId' in v || v.id != null)) return true;
  if (Array.isArray(v) && v.length > 0) {
    const first = v[0];
    if (typeof first === 'object' && first !== null && ('documentId' in first || first.id != null)) return true;
  }
  return false;
}

function extractRelationDocIds(v) {
  if (v == null) return [];
  if (typeof v === 'string' || typeof v === 'number') return [v];
  if (typeof v === 'object' && v !== null) {
    const id = v.documentId ?? v.id;
    if (id != null) return [id];
  }
  if (Array.isArray(v)) return v.map(x => (x != null && typeof x === 'object' ? (x.documentId ?? x.id) : x)).filter(id => id != null && id !== '');
  return [];
}

// publishedAt is not stripped so original publish date is sent; createdAt/updatedAt are omitted (Cloud sets them).
const STRIP_KEYS_FOR_API = new Set(['documentId', 'id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'localizations', 'locale']);

/** Normalize ref/documentId to string so docIdMap lookups work (export may use number or string). */
function toMapKey(id) {
  return id == null ? '' : String(id);
}

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

/** Flatten nested relation bags (e.g. attributes.category, attributes.tenant) so Phase 2 sees one-level field -> value. */
function flattenRelations(relations) {
  if (!relations || typeof relations !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(relations)) {
    if (isRelationValue(v)) {
      out[k] = v;
    } else if (Array.isArray(v) && v.length > 0 && v.every(isRelationValue)) {
      out[k] = v;
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const flat = flattenRelations(v);
      for (const [k2, v2] of Object.entries(flat)) out[k2] = v2;
    }
  }
  return out;
}

function buildConnectPayload(relationValue, docIdMap, logContext) {
  const ids = extractRelationDocIds(relationValue);
  const mapped = ids.map(id => docIdMap.get(toMapKey(id))).filter(Boolean);
  if (logContext && ids.length > 0) {
    const missing = ids.filter(id => !docIdMap.has(toMapKey(id)));
    if (missing.length > 0) {
      console.warn(`[Phase 2] ${logContext.type} ref ${logContext.ref}: field "${logContext.field}" target(s) not in map (refs: ${missing.join(', ')}) – relation will be empty.`);
    }
  }
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

/** Normalize slug for dedupe: lowercase, spaces and punctuation to single hyphen. */
function normalizeSlug(s) {
  if (s == null || typeof s !== 'string') return '';
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** GET existing document by slug (exact match); returns documentId or null. */
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

/** GET existing document by slug (case-insensitive) to avoid duplicates (e.g. Featured-News vs featured-news). */
async function findExistingBySlugCaseInsensitive(baseUrl, plural, slug) {
  const normalized = normalizeSlug(slug);
  if (!normalized) return null;
  const encoded = encodeURIComponent(normalized);
  const url = `${baseUrl}/api/${plural}?filters[slug][$eqi]=${encoded}&pagination[pageSize]=1`;
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
    const skippedTypeCounts = {}; // types in export but not in project (e.g. removed content type)
    const singleTypeData = {}; // type -> single document data + relationFields
    const uploadFiles = []; // { ref, url, name } from plugin::upload.file (S3 URLs in export)
    const linksList = []; // { leftRef, rightRef, field } from links/*.jsonl

    let readStream = fs.createReadStream(exportPath);
    if (exportPath.endsWith('.gz')) {
      readStream = readStream.pipe(createGunzip());
    }
    const extract = tarStream.extract();

    function processJsonlStream(stream, next, onLine) {
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        const content = Buffer.concat(chunks).toString();
        const lines = content.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            onLine(JSON.parse(line));
          } catch (_) {}
        }
        next();
      });
      stream.resume();
    }

    extract.on('entry', (header, stream, next) => {
      const name = header.name;
      if (name.startsWith('links/') && name.endsWith('.jsonl')) {
        processJsonlStream(stream, next, (row) => {
          const leftRef = row.leftRef ?? (row.left && typeof row.left === 'object' ? (row.left.documentId ?? row.left.ref) : undefined) ?? row.left ?? row.sourceRef;
          const rightRef = row.rightRef ?? (row.right && typeof row.right === 'object' ? (row.right.documentId ?? row.right.ref) : undefined) ?? row.right ?? row.targetRef;
          const field = row.field ?? row.attribute ?? row.relation;
          if (leftRef != null && rightRef != null && field) {
            linksList.push({ leftRef, rightRef, field });
          }
        });
        return;
      }
      if (!name.startsWith('entities/') || !name.endsWith('.jsonl')) {
        stream.resume();
        next();
        return;
      }
      processJsonlStream(stream, next, (row) => {
        const type = row.type || row.ref;
        const ref = row.ref ?? row.data?.documentId ?? row.documentId;
        const data = row.data ?? row.attributes ?? row;
        const numericId = row.id ?? row.data?.id ?? data?.id;
        if (!type || typeof type !== 'string') return;
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
          return;
        }
        if (!typeToPlural[type]) {
          skippedTypeCounts[type] = (skippedTypeCounts[type] || 0) + 1;
          return;
        }
        const { plain, relations } = stripRelationsForPhase1(data);
        const flatRels = flattenRelations(relations);
        if (singleTypes.has(type)) {
          singleTypeData[type] = { plain, relations: flatRels, ref };
        } else {
          if (!entitiesByType[type]) entitiesByType[type] = [];
          entitiesByType[type].push({ ref, plain, relations: flatRels, id: numericId });
          entityMeta.push({ type, ref, id: numericId, relations: flatRels });
        }
      });
    });

    extract.on('finish', () => {
      if (Object.keys(skippedTypeCounts).length > 0) {
        console.log('Skipped export entries for types not in project:', Object.entries(skippedTypeCounts).map(([t, n]) => `${t} (${n})`).join(', '));
      }
      const refToMetaIndex = new Map();
      entityMeta.forEach((m, i) => {
        refToMetaIndex.set(toMapKey(m.ref), i);
        if (m.id != null && m.id !== '') refToMetaIndex.set(toMapKey(m.id), i);
      });
      let matchedLinks = 0;
      for (const { leftRef, rightRef, field } of linksList) {
        const idx = refToMetaIndex.get(toMapKey(leftRef));
        if (idx == null) continue;
        matchedLinks++;
        const rel = entityMeta[idx].relations;
        const existing = rel[field];
        if (existing == null) {
          rel[field] = rightRef;
        } else {
          const arr = Array.isArray(existing) ? existing : [existing];
          arr.push(rightRef);
          rel[field] = arr;
        }
      }
      if (linksList.length > 0) {
        console.log('Merged', linksList.length, 'relation links from export links/ into entity meta.', matchedLinks, 'links matched entities.');
        if (matchedLinks === 0) {
          const sampleLink = linksList[0];
          const sampleRef = entityMeta[0]?.ref;
          console.warn('No links matched: link leftRef sample:', typeof sampleLink?.leftRef, JSON.stringify(sampleLink?.leftRef)?.slice(0, 60), '| entity ref sample:', typeof sampleRef, JSON.stringify(sampleRef)?.slice(0, 60));
        }
      }
      resolve({ entitiesByType, entityMeta, singleTypeData, uploadFiles });
    });
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
  let { entitiesByType, entityMeta, singleTypeData, uploadFiles } = await extractEntitiesAndLinksFromExport(resolved, typeToPlural, singleTypes);

  // Only upload media that are referenced by entities we push (cover, image). Skips ~16k unreferenced/demo files and 403s.
  const MEDIA_RELATION_FIELDS = new Set(['cover', 'image']);
  const neededUploadRefs = new Set();
  for (const m of entityMeta) {
    if (!m.relations) continue;
    for (const [field, value] of Object.entries(m.relations)) {
      if (MEDIA_RELATION_FIELDS.has(field)) {
        for (const id of extractRelationDocIds(value)) neededUploadRefs.add(toMapKey(id));
      }
    }
  }
  const uploadCountBefore = uploadFiles.length;
  uploadFiles = uploadFiles.filter(f => neededUploadRefs.has(toMapKey(f.ref)));
  const demoPattern = /@strapi|coffee-art|coffee-beans|the-internet-s-own|sarahbaker|daviddoe|what-s-inside-a-black-hole|favicon|default-image|beautiful-picture|shrimp-is-awesome|bug-is-becoming|a-bug-is/i;
  uploadFiles = uploadFiles.filter(f => !demoPattern.test(String(f.name || '')));
  if (uploadCountBefore > 0 && uploadFiles.length < uploadCountBefore) {
    console.log('Upload filter: only referenced media (cover/image).', uploadCountBefore, '→', uploadFiles.length, 'files (skipped unreferenced and demo samples).');
  }

  // Counts and approximate duration (before DRY_RUN / Phase 0)
  const numUploads = INCLUDE_UPLOADS ? uploadFiles.length : 0;
  const numSingleTypes = Object.keys(singleTypeData).length;
  const numCollectionEntries = Object.values(entitiesByType).reduce((sum, list) => sum + (list?.length || 0), 0);
  const numRelationPatches = entityMeta.filter(m => m.relations && Object.keys(m.relations).length > 0).length;
  const uploadSec = numUploads * 3; // ~3 s per file (fetch + POST)
  const apiRequests = numSingleTypes + numCollectionEntries + numRelationPatches;
  const apiSec = apiRequests * 0.8; // ~0.8 s per API request
  const totalSec = uploadSec + apiSec;
  const approxMin = totalSec < 60 ? 1 : Math.round(totalSec / 60);
  console.log('\nExport counts: uploads', numUploads, '| single types', numSingleTypes, '| collection entries', numCollectionEntries, '| relation patches', numRelationPatches);
  if (numRelationPatches === 0 && numCollectionEntries > 0) {
    console.warn('Warning: 0 relation patches – category/tenant/author/cover/diocese will not be linked. Check export format (entities need relation fields with documentId/id, or links/ with leftRef/rightRef/field).');
  }
  if (uploadFiles.length > 0 && !INCLUDE_UPLOADS) {
    console.warn('Warning: REST_PUSH_INCLUDE_UPLOADS=0 – skipping', uploadFiles.length, 'media files. Set REST_PUSH_INCLUDE_UPLOADS=1 or remove it from .env to push images and link cover/Bishop image.');
  }
  console.log('Approximate duration:', approxMin, 'minute' + (approxMin !== 1 ? 's' : '') + (DRY_RUN ? ' (dry run: no requests)' : '') + '\n');

  const docIdMap = new Map(); // old ref/documentId -> new documentId from Cloud

  // Phase 0: create media on Cloud so cover/image relations can be linked. We fetch each file from
  // the export URL and POST to /api/upload (physical re-upload). Strapi has no "create by URL only" API.
  if (INCLUDE_UPLOADS && uploadFiles.length > 0) {
    console.log('\nPhase 0: re-uploading', uploadFiles.length, 'file(s) from export URLs (fetch from S3 then POST to Cloud /api/upload)...');
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
        if (newId) docIdMap.set(toMapKey(file.ref), newId);
        uploadOk++;
        if ((i + 1) % 25 === 0) console.log('  uploads', i + 1 + '/' + uploadFiles.length);
      } catch (err) {
        console.warn('✖ upload', file.name, file.ref, err.message);
        if (/Fetch 403|403 Forbidden/i.test(err.message)) {
          console.warn('  → S3 URL may be private: ensure bucket allows GetObject (bucket policy or public read). ACL fix in config/env only affects Strapi’s upload to S3, not this script’s fetch.');
        }
      }
    }
    console.log('✓ uploads', uploadOk + '/' + uploadFiles.length);
    if (uploadFiles.length > 0 && uploadOk === 0) {
      console.warn('No uploads succeeded. Cover/image relations will be empty. If export URLs are S3, ensure bucket allows GetObject (bucket policy or public read). ACL in config/env only affects Strapi upload to S3, not this script\'s fetch.');
    }
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
      if (newId && one.ref) docIdMap.set(toMapKey(one.ref), newId);
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
  const PUSH_FIRST = ['tenants', 'editor-tenants', 'categories', 'authors', 'dioceses', 'parishes'];
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
      const setDocIdMap = (exportRef, exportId, cloudDocId) => {
        if (cloudDocId) {
          docIdMap.set(toMapKey(exportRef), cloudDocId);
          if (exportId != null && exportId !== '') docIdMap.set(toMapKey(exportId), cloudDocId);
        }
      };
      for (let i = 0; i < batch.length; i++) {
        if (DELAY_BETWEEN_REQUESTS_MS > 0 && i > 0) await sleep(DELAY_BETWEEN_REQUESTS_MS);
        const { ref, plain, id: exportId } = batch[i];
        const payload = sanitizeForApi(plain);
        // Avoid duplicate entries (e.g. same category with different slug casing): reuse existing by normalized slug.
        if (payload.slug) {
          const existingId = await findExistingBySlugCaseInsensitive(CLOUD_URL, plural, payload.slug);
          if (existingId) {
            setDocIdMap(ref, exportId, existingId);
            ok++;
            continue;
          }
        }
        try {
          const res = await fetchWithRetry(api(plural), {
            method: 'POST',
            body: JSON.stringify({ data: payload }),
          }, `${plural} batch ${batchNum} entry ${i + 1}`);
          const newId = res?.data?.documentId;
          setDocIdMap(ref, exportId, newId);
          ok++;
        } catch (err) {
          const isUniqueError = /unique|must be unique/i.test(err.message);
          if (isUniqueError && payload.slug) {
            const existingId = await findExistingBySlug(CLOUD_URL, plural, payload.slug)
              || await findExistingBySlugCaseInsensitive(CLOUD_URL, plural, payload.slug);
            if (existingId) {
              setDocIdMap(ref, exportId, existingId);
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
      const newDocId = docIdMap.get(toMapKey(ref));
      if (!newDocId) continue;
      const plural = typeToPlural[type];
      if (!plural) continue;
      const connectPayload = {};
      for (const [field, value] of Object.entries(relations)) {
        const conn = buildConnectPayload(value, docIdMap, { type, ref, field });
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
