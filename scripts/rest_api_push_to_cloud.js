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
 *   REST_PUSH_RETRY_LIMIT – optional, default 3. Or use --retry=N (e.g. --retry=1 for no retries).
 *   REST_PUSH_DELAY_MS   – optional, ms between requests (default 0).
 *   REST_PUSH_DRY_RUN    – set to 1 to only parse and log, no HTTP.
 *   REST_PUSH_INCLUDE_UPLOADS – set to 1 to push upload (media) so cover/image can be linked.
 *     Default: 1. Set to 0 to skip (cover/image will stay empty).
 *   REST_PUSH_UPLOAD_SOURCE – "url" (default) or "local". Use "local" to read from public/uploads
 *     instead of fetching from export URLs. CLI: --uploads=local.
 *   REST_PUSH_UPLOADS_DIR – directory for local uploads (default: project/public/uploads).
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

const projectRoot = path.resolve(__dirname, '..');
const retryArg = process.argv.find(a => a.startsWith('--retry='));
const retryFromArg = retryArg ? parseInt(retryArg.split('=')[1], 10) : NaN;
const uploadsArg = process.argv.find(a => a.startsWith('--uploads='));
const uploadsFromArg = uploadsArg ? uploadsArg.split('=')[1] : null;
const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const BATCH_SIZE = Math.max(1, parseInt(process.env.REST_PUSH_BATCH_SIZE || '20', 10));
const RETRY_LIMIT = Math.max(0, Number.isFinite(retryFromArg) ? retryFromArg : parseInt(process.env.REST_PUSH_RETRY_LIMIT || '3', 10));
const RETRY_DELAY_MS = 2000;
const DELAY_BETWEEN_REQUESTS_MS = Math.max(0, parseInt(process.env.REST_PUSH_DELAY_MS || '0', 10));
const DRY_RUN = process.env.REST_PUSH_DRY_RUN === '1' || process.env.REST_PUSH_DRY_RUN === 'true';
const INCLUDE_UPLOADS = process.env.REST_PUSH_INCLUDE_UPLOADS !== '0';
const UPLOAD_SOURCE = (uploadsFromArg || process.env.REST_PUSH_UPLOAD_SOURCE || 'url').toLowerCase();
const USE_LOCAL_UPLOADS = UPLOAD_SOURCE === 'local';
const UPLOADS_DIR = path.resolve(projectRoot, process.env.REST_PUSH_UPLOADS_DIR || path.join('public', 'uploads'));

if (!CLOUD_URL || !API_TOKEN) {
  console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN (Full Access token on destination).');
  process.exit(1);
}

function loadTypeToPluralAndSingleTypes() {
  const typeToPlural = {};
  const singleTypes = new Set();
  const typeToAttributes = {}; // uid -> Set of attribute names from schema
  const apiPath = path.join(projectRoot, 'src', 'api');
  if (!fs.existsSync(apiPath)) return { typeToPlural, singleTypes, typeToAttributes };
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
      if (schema.attributes) {
        typeToAttributes[uid] = new Set(Object.keys(schema.attributes));
      }
    } catch (_) {}
  }
  return { typeToPlural, singleTypes, typeToAttributes };
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

/** Normalize link field name to our attribute name (e.g. "api::article.article::category" -> "category"). */
function normalizeRelationField(field) {
  if (!field || typeof field !== 'string') return field;
  const lower = field.toLowerCase();
  const known = ['category', 'tenant', 'cover', 'author', 'image', 'diocese', 'parish'];
  for (const k of known) {
    if (field === k) return k;
    if (lower.endsWith('::' + k) || lower.endsWith('.' + k)) return k;
    if (lower.includes('::' + k) || lower.includes('.' + k + '.') || lower.includes('.' + k + '::')) return k;
  }
  return field;
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
  // Deduplicate: multiple sources (entity data + links) may resolve to the same Cloud ID
  const mapped = [...new Set(ids.map(id => docIdMap.get(toMapKey(id))).filter(Boolean))];
  if (logContext && ids.length > 0) {
    const missing = ids.filter(id => !docIdMap.has(toMapKey(id)));
    if (missing.length > 0) {
      console.warn(`[Phase 2] ${logContext.type} ref ${logContext.ref}: field "${logContext.field}" target(s) not in map (refs: ${missing.join(', ')}) – relation will be empty.`);
    }
  }
  if (mapped.length === 0) return undefined;
  return { connect: mapped.map(documentId => ({ documentId })) };
}

/** Resolve a local file path for an upload entry. Tries data.path, then name in uploads dir, then basename(url). */
function resolveLocalUploadPath(uploadsDir, file) {
  if (!fs.existsSync(uploadsDir)) return null;
  const data = file.data || {};
  const name = file.name || data.name || '';
  // 1) Export path like /uploads/xyz or uploads/xyz (relative to project public)
  const rawPath = data.path || data.filePath;
  if (rawPath) {
    const normalized = rawPath.replace(/^\/+/, '');
    const full = path.isAbsolute(rawPath) ? rawPath : path.join(uploadsDir, '..', normalized);
    if (fs.existsSync(full)) return full;
    const inUploads = path.join(uploadsDir, path.basename(normalized));
    if (fs.existsSync(inUploads)) return inUploads;
  }
  // 2) Exact filename in uploads dir
  if (name) {
    const byName = path.join(uploadsDir, name);
    if (fs.existsSync(byName)) return byName;
  }
  // 3) Basename from URL (e.g. S3 key)
  if (file.url) {
    try {
      const base = path.basename(new URL(file.url).pathname);
      if (base) {
        const byBase = path.join(uploadsDir, base);
        if (fs.existsSync(byBase)) return byBase;
      }
    } catch (_) {}
  }
  // 4) One-level scan: any file whose name includes the export name or hash
  if (name) {
    const baseNoExt = path.basename(name, path.extname(name));
    const entries = fs.readdirSync(uploadsDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && (e.name === name || e.name.startsWith(baseNoExt) || e.name.includes(baseNoExt))) {
        return path.join(uploadsDir, e.name);
      }
    }
  }
  return null;
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
    const rawLinkSamples = []; // first few raw link rows for diagnostics (any field)
    const mediaFieldNames = new Set(); // dynamically discovered media field names from morph links

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
          const leftObj = row.left ?? row.source;
          const rightObj = row.right ?? row.target;

          // Is this a polymorphic (morph) relation? (e.g. upload.file → entity media field)
          const isMorph = /morph/i.test(row.kind || '') || /morph/i.test(row.relation || '');

          // Extract raw numeric/string refs from left and right objects
          const rawLeftRef = row.leftRef ?? row.leftDocumentId ?? row.sourceRef
            ?? (leftObj && typeof leftObj === 'object' ? (leftObj.documentId ?? leftObj.ref ?? leftObj.id) : undefined)
            ?? (typeof row.left === 'string' || typeof row.left === 'number' ? row.left : undefined)
            ?? row.left;
          const rawRightRef = row.rightRef ?? row.rightDocumentId ?? row.targetRef
            ?? (rightObj && typeof rightObj === 'object' ? (rightObj.documentId ?? rightObj.ref ?? rightObj.id) : undefined)
            ?? (typeof row.right === 'string' || typeof row.right === 'number' ? row.right : undefined)
            ?? row.right;

          // Extract actual attribute field names from left/right objects
          const leftField = (leftObj && typeof leftObj === 'object') ? leftObj.field : null;
          const rightField = (rightObj && typeof rightObj === 'object') ? rightObj.field : null;

          let ownerRef, targetRef, field;

          if (isMorph) {
            // Morph: left = upload/media file, right = entity that owns the media field
            // Owner is the right side; target (upload ref) is the left side
            ownerRef = rawRightRef;
            targetRef = rawLeftRef;
            field = rightField || leftField;
            // Track media field names for upload filtering
            if (leftObj && typeof leftObj === 'object' && leftObj.type === 'plugin::upload.file' && rightField) {
              mediaFieldNames.add(rightField);
            }
          } else {
            // Regular: left entity owns the field pointing to right entity
            ownerRef = rawLeftRef;
            targetRef = rawRightRef;
            field = leftField || rightField;
          }

          // Fallback for other export formats (NOT row.relation — that's "manyToOne" etc., not a field name)
          if (!field) {
            field = row.field ?? row.attribute ?? row.attributeName ?? row.name;
          }

          // Extract owner and target types for type-qualified numeric ID resolution
          let ownerType = null, targetType = null;
          if (isMorph) {
            ownerType = (rightObj && typeof rightObj === 'object') ? rightObj.type : null;
            targetType = (leftObj && typeof leftObj === 'object') ? leftObj.type : null;
          } else {
            ownerType = (leftObj && typeof leftObj === 'object') ? leftObj.type : null;
            targetType = (rightObj && typeof rightObj === 'object') ? rightObj.type : null;
          }

          if (ownerRef != null && targetRef != null && field) {
            linksList.push({ leftRef: ownerRef, rightRef: targetRef, field, ownerType, targetType });
            if (rawLinkSamples.length < 3) rawLinkSamples.push({ ...row });
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
        const ref = row.documentId ?? row.ref ?? row.data?.documentId ?? row.data?.id;
        const data = row.data ?? row.attributes ?? row;
        const numericId = row.id ?? row.data?.id ?? data?.id;
        if (!type || typeof type !== 'string') return;
        if (type === 'plugin::upload.file') {
          const url = data?.url;
          const hasUrl = url && (url.startsWith('http://') || url.startsWith('https://'));
          let baseName = data?.name;
          if (!baseName && hasUrl) {
            try {
              baseName = path.basename(new URL(url).pathname) || 'file';
            } catch (_) {
              baseName = 'file';
            }
          }
          if (!baseName && (data?.path || data?.hash)) baseName = path.basename(data.path || '') || data.hash || 'file';
          if (hasUrl || baseName) {
            uploadFiles.push({ ref, numericId, url: hasUrl ? url : null, name: baseName || 'file', data });
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
      // Index entities by documentId (globally unique) and by type-qualified numeric ID
      const refToMetaIndex = new Map(); // documentId → entityMeta index
      const typeIdToMetaIndex = new Map(); // "type:numericId" → entityMeta index
      entityMeta.forEach((m, i) => {
        const kRef = toMapKey(m.ref);
        refToMetaIndex.set(kRef, i);
        if (m.id != null && m.id !== '' && m.type) {
          typeIdToMetaIndex.set(m.type + ':' + toMapKey(m.id), i);
        }
      });

      // Build type-qualified resolution map: "type:numericId" → documentId string
      // This avoids numeric ID collision (author ID 1 != tenant ID 1 != category ID 1)
      const typeIdToDocId = new Map();
      entityMeta.forEach(m => {
        if (m.id != null && m.id !== '' && m.type && m.ref) {
          typeIdToDocId.set(m.type + ':' + toMapKey(m.id), toMapKey(m.ref));
        }
      });
      for (const f of uploadFiles) {
        if (f.numericId != null && f.ref != null) {
          typeIdToDocId.set('plugin::upload.file:' + toMapKey(f.numericId), toMapKey(f.ref));
        }
      }

      let matchedLinks = 0;
      for (const { leftRef, rightRef, field, ownerType, targetType } of linksList) {
        const key = toMapKey(leftRef);
        // Find owner entity: prefer type-qualified lookup to avoid numeric ID collision
        let idx;
        if (ownerType) {
          idx = typeIdToMetaIndex.get(ownerType + ':' + key);
        }
        if (idx == null) idx = refToMetaIndex.get(key);
        if (idx == null) continue;
        matchedLinks++;
        const normField = normalizeRelationField(field);
        const rel = entityMeta[idx].relations;

        // Resolve target ref to documentId to avoid numeric ID collision in Phase 2
        let resolvedTarget = rightRef;
        if (targetType) {
          const docId = typeIdToDocId.get(targetType + ':' + toMapKey(rightRef));
          if (docId) resolvedTarget = docId;
        }

        const existing = rel[normField];
        if (existing == null) {
          rel[normField] = resolvedTarget;
        } else {
          const arr = Array.isArray(existing) ? existing : [existing];
          arr.push(resolvedTarget);
          rel[normField] = arr;
        }
      }
      if (linksList.length > 0) {
        console.log('Merged', linksList.length, 'relation links from export links/ into entity meta.', matchedLinks, 'links matched entities.');
        const matchRate = linksList.length ? (matchedLinks / linksList.length) : 0;
        if (matchRate < 0.1 || matchedLinks === 0) {
          const fieldNames = [...new Set(linksList.map(l => l.field))].slice(0, 20);
          console.warn('Low link match rate. All link field names in export (sample):', fieldNames);
          const articleMeta = entityMeta.filter(m => m.type === 'api::article.article').slice(0, 3);
          console.warn('Sample article entity refs:', articleMeta.map(m => ({ ref: m.ref, id: m.id })));
          rawLinkSamples.forEach((raw, i) => {
            console.warn('Raw link row #' + (i + 1) + ':', JSON.stringify(raw).slice(0, 400));
          });
        }
      }
      resolve({ entitiesByType, entityMeta, singleTypeData, uploadFiles, mediaFieldNames });
    });
    extract.on('error', reject);
    readStream.pipe(extract);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const exportPath = args.find(a => !a.startsWith('--')) || process.env.EXPORT_FILE || path.join(projectRoot, 'my-export.tar.gz');
  const altPath = exportPath.replace(/\.gz$/, '');
  const resolved = fs.existsSync(exportPath) ? exportPath : (fs.existsSync(altPath) ? altPath : null);
  if (!resolved) {
    console.error('Export file not found:', exportPath);
    console.error('Create one with: npm run strapi export -- --no-encrypt -f my-export');
    process.exit(1);
  }

  const { typeToPlural, singleTypes, typeToAttributes } = loadTypeToPluralAndSingleTypes();
  console.log('Loaded', Object.keys(typeToPlural).length, 'content types from project schema.');
  if (DRY_RUN) console.log('DRY RUN – no HTTP requests will be made.\n');

  console.log('Reading export:', resolved);
  let { entitiesByType, entityMeta, singleTypeData, uploadFiles, mediaFieldNames } = await extractEntitiesAndLinksFromExport(resolved, typeToPlural, singleTypes);

  // Only upload media that are referenced by entities we push. Includes hardcoded fields + dynamically discovered morph fields.
  const MEDIA_RELATION_FIELDS = new Set(['cover', 'image', ...mediaFieldNames]);
  if (mediaFieldNames.size > 0) {
    console.log('Media relation fields (from morph links):', [...mediaFieldNames].join(', '));
  }
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
  uploadFiles = uploadFiles.filter(f => neededUploadRefs.has(toMapKey(f.ref)) || (f.numericId != null && neededUploadRefs.has(toMapKey(f.numericId))));
  const demoPattern = /@strapi|coffee-art|coffee-beans|the-internet-s-own|sarahbaker|daviddoe|what-s-inside-a-black-hole|favicon|default-image|beautiful-picture|shrimp-is-awesome|bug-is-becoming|a-bug-is/i;
  uploadFiles = uploadFiles.filter(f => !demoPattern.test(String(f.name || '')));
  if (uploadCountBefore > 0 && uploadFiles.length < uploadCountBefore) {
    console.log('Upload filter: only referenced media (cover/image).', uploadCountBefore, '→', uploadFiles.length, 'files (skipped unreferenced and demo samples).');
  }
  if (uploadCountBefore > 0 && uploadFiles.length === 0 && neededUploadRefs.size === 0) {
    console.warn('No cover/image relations were merged from export links, so 0 files to upload. Fix link matching so category/tenant/cover links apply (see low match rate warning above).');
  }

  if (USE_LOCAL_UPLOADS && uploadFiles.length > 0) {
    let resolved = 0;
    for (const f of uploadFiles) {
      const localPath = resolveLocalUploadPath(UPLOADS_DIR, f);
      if (localPath) {
        f.localPath = localPath;
        resolved++;
      }
    }
    console.log('Local uploads: using', UPLOADS_DIR, '–', resolved + '/' + uploadFiles.length, 'files resolved.');
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
  const uploadIdMap = new Map(); // old upload ref -> Cloud numeric file ID (for media field PATCHes)

  // Detect Cloud default locale (Strapi 5 internally stores a locale even for non-localized types)
  let detectedLocale = null;
  if (!DRY_RUN) {
    try {
      const localesRes = await fetch(`${CLOUD_URL}/api/i18n/locales`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      });
      if (localesRes.ok) {
        const locales = await localesRes.json();
        const defaultLoc = Array.isArray(locales) ? locales.find(l => l.isDefault) : null;
        detectedLocale = defaultLoc?.code || null;
      }
    } catch (_) {}
    if (detectedLocale) {
      console.log('Detected Cloud default locale:', detectedLocale);
    } else {
      detectedLocale = 'en';
      console.log('Could not detect Cloud locale, defaulting to: en');
    }
  }

  // Phase 0: create media on Cloud so cover/image relations can be linked. We fetch each file from
  // the export URL and POST to /api/upload (physical re-upload). Strapi has no "create by URL only" API.
  if (INCLUDE_UPLOADS && uploadFiles.length > 0) {
    const sourceLabel = USE_LOCAL_UPLOADS ? 'local (public/uploads)' : 'export URLs (fetch then POST)';
    console.log('\nPhase 0: re-uploading', uploadFiles.length, 'file(s) from', sourceLabel, '...');
    let uploadOk = 0;
    for (let i = 0; i < uploadFiles.length; i++) {
      const file = uploadFiles[i];
      if (DRY_RUN) {
        console.log('[dry-run] upload', file.name, file.localPath ? file.localPath : (file.url || '').slice(0, 60) + '...');
        uploadOk++;
        continue;
      }
      let buf;
      if (file.localPath && fs.existsSync(file.localPath)) {
        buf = fs.readFileSync(file.localPath);
      } else if (file.url) {
        try {
          const res = await fetch(file.url, { redirect: 'follow' });
          if (!res.ok) throw new Error(`Fetch ${res.status}`);
          buf = Buffer.from(await res.arrayBuffer());
        } catch (err) {
          console.warn('✖ upload', file.name, file.ref, err.message);
          if (/Fetch 403|403 Forbidden/i.test(err.message)) {
            console.warn('  → S3 URL may be private. Use --uploads=local to read from public/uploads instead.');
          }
          continue;
        }
      } else {
        console.warn('✖ upload', file.name, file.ref, 'no local path or URL (use --uploads=local and ensure file exists in public/uploads).');
        continue;
      }
      try {
        // Determine correct MIME type and filename with extension from export metadata
        const data = file.data || {};
        const mime = data.mime || (file.localPath ? {
          '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
          '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
          '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
        }[path.extname(file.localPath).toLowerCase()] : null) || 'application/octet-stream';
        const ext = data.ext || (file.localPath ? path.extname(file.localPath) : '') || '';
        // Ensure filename has the correct extension so Strapi detects the format
        let uploadName = file.name;
        if (ext && !uploadName.toLowerCase().endsWith(ext.toLowerCase())) {
          uploadName = uploadName + ext;
        }
        const form = new FormData();
        form.append('files', new Blob([new Uint8Array(buf)], { type: mime }), uploadName);
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
        const newDocId = created?.documentId ?? raw?.documentId;
        const newNumericId = created?.id ?? raw?.id;
        const newId = newDocId || newNumericId;
        if (newId) {
          docIdMap.set(toMapKey(file.ref), newId);
          if (file.numericId != null) docIdMap.set(toMapKey(file.numericId), newId);
        }
        // Store numeric file ID for media field PATCHes (Strapi Content API uses numeric IDs for media)
        if (newNumericId != null) {
          if (file.ref != null) uploadIdMap.set(toMapKey(file.ref), newNumericId);
          if (file.numericId != null) uploadIdMap.set(toMapKey(file.numericId), newNumericId);
        }
        uploadOk++;
        if ((i + 1) % 25 === 0) console.log('  uploads', i + 1 + '/' + uploadFiles.length);
      } catch (err) {
        console.warn('✖ upload', file.name, file.ref, err.message);
        if (false && /Fetch 403|403 Forbidden/i.test(err.message)) {
          console.warn('  → S3 URL may be private: ensure bucket allows GetObject (bucket policy or public read). ACL fix in config/env only affects Strapi’s upload to S3, not this script’s fetch.');
        }
      }
    }
    console.log('✓ uploads', uploadOk + '/' + uploadFiles.length);
    if (uploadFiles.length > 0 && uploadOk === 0) {
      console.warn('No uploads succeeded. Cover/image relations will be empty. Use --uploads=local if files are in public/uploads.');
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

  // Phase 2: restore relations (PATCH). API expects attribute names (category, tenant, author, cover). Export may nest under manyToOne/oneToOne – expand those.
  // Fields that must NOT be sent in Phase 2 PATCH (Strapi Cloud rejects them as "Invalid key"):
  const SKIP_RELATION_FIELDS = new Set(['localizations', 'locale', 'role', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt']);
  const RELATION_TYPE_KEYS = new Set(['manyToOne', 'oneToOne', 'oneToMany', 'morphToMany', 'morphToOne']);

  /** Build a media field value: Strapi Content API expects numeric file ID for media, not connect format. */
  function buildMediaPayload(relationValue, logContext) {
    const ids = extractRelationDocIds(relationValue);
    // Look up Cloud numeric file IDs (not documentIds) for media fields
    const numericIds = ids.map(id => uploadIdMap.get(toMapKey(id))).filter(id => id != null);
    if (numericIds.length === 0) {
      if (logContext && ids.length > 0) {
        const missing = ids.filter(id => !uploadIdMap.has(toMapKey(id)));
        if (missing.length > 0) {
          console.warn(`[Phase 2] ${logContext.type} ref ${logContext.ref}: media field "${logContext.field}" upload(s) not in map (refs: ${missing.join(', ')}) – media will be empty.`);
        }
      }
      return undefined;
    }
    // Single media: just the numeric ID; multiple: array of IDs
    return numericIds.length === 1 ? numericIds[0] : numericIds;
  }

  function addConnectPayload(connectPayload, field, value, logContext, isMediaField, schemaAttrs) {
    if (RELATION_TYPE_KEYS.has(field) && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const [subField, subValue] of Object.entries(value)) {
        if (SKIP_RELATION_FIELDS.has(subField) || subField === 'undefined') continue;
        // Validate sub-field against schema
        if (schemaAttrs && !schemaAttrs.has(subField)) continue;
        const subIsMedia = mediaFieldNames.has(subField);
        if (subIsMedia) {
          const media = buildMediaPayload(subValue, { ...logContext, field: subField });
          if (media != null) connectPayload[subField] = media;
        } else {
          const conn = buildConnectPayload(subValue, docIdMap, { ...logContext, field: subField });
          if (conn) connectPayload[subField] = conn;
        }
      }
      return;
    }
    if (RELATION_TYPE_KEYS.has(field)) return;
    if (isMediaField) {
      const media = buildMediaPayload(value, { ...logContext, field });
      if (media != null) connectPayload[field] = media;
    } else {
      const conn = buildConnectPayload(value, docIdMap, { ...logContext, field });
      if (conn) connectPayload[field] = conn;
    }
  }
  const withRelations = entityMeta.filter(m => m.relations && Object.keys(m.relations).length > 0);
  if (withRelations.length > 0 && !DRY_RUN) {
    console.log('\nPhase 2: restoring relations for', withRelations.length, 'entities...');
    let phase2Count = 0;
    let phase2Ok = 0;
    for (const { type, ref, relations } of withRelations) {
      const newDocId = docIdMap.get(toMapKey(ref));
      if (!newDocId) continue;
      const plural = typeToPlural[type];
      if (!plural) continue;
      const connectPayload = {};
      const logContext = { type, ref };
      const schemaAttrs = typeToAttributes[type]; // Set of valid attribute names for this content type
      for (const [field, value] of Object.entries(relations)) {
        if (!field || field === 'undefined' || SKIP_RELATION_FIELDS.has(field)) continue;
        // If field is a known relation-type wrapper key (manyToOne etc.), expand its children
        if (RELATION_TYPE_KEYS.has(field)) {
          addConnectPayload(connectPayload, field, value, logContext, false, schemaAttrs);
          continue;
        }
        // Skip fields that don't exist on this content type's schema (e.g. "image" on tenant)
        if (schemaAttrs && !schemaAttrs.has(field)) continue;
        const isMediaField = mediaFieldNames.has(field);
        addConnectPayload(connectPayload, field, value, logContext, isMediaField, schemaAttrs);
      }
      if (Object.keys(connectPayload).length === 0) continue;
      phase2Count++;
      // Log first 3 payloads for diagnostics
      if (phase2Count <= 3) {
        console.log(`[Phase 2 debug] PUT ${api(plural, newDocId)}`);
        console.log(`  payload:`, JSON.stringify({ data: connectPayload }).slice(0, 500));
      }
      try {
        await fetchWithRetry(api(plural, newDocId), {
          method: 'PUT',
          body: JSON.stringify({ data: connectPayload }),
        }, `PATCH ${type} ${newDocId}`);
        phase2Ok++;
      } catch (err) {
        console.warn(`Relation patch failed for ${type} ${ref}:`, err.message);
      }
    }
    console.log(`✓ relations phase done. ${phase2Ok}/${phase2Count} succeeded.`);
  }

  console.log('\nDone. documentId map size:', docIdMap.size);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
