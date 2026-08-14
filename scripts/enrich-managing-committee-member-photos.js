'use strict';

/**
 * Enrich Managing Committee Members with portrait photos by reusing existing
 * Strapi media from other tenant-scoped directory collections.
 *
 * Does NOT recreate text rows. Does NOT modify source collection schemas/data
 * (only reads media and connects the same upload file to MC member.photo).
 *
 * Usage:
 *   node scripts/enrich-managing-committee-member-photos.js --dry-run
 *   node scripts/enrich-managing-committee-member-photos.js --tenant-id=mosc_malankara_orthodox_2 --term-year=2026
 *   node scripts/enrich-managing-committee-member-photos.js --replace-photos --min-score=0.75
 *
 * npm: npm run import:managing-committee-members:photos -- --dry-run
 */

try {
  require('dotenv').config();
} catch (_) {}

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');
const mime = require('mime-types');

const UID = 'api::managing-committee-member.managing-committee-member';

const DRY_RUN =
  process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');
const REPLACE_PHOTOS = process.argv.includes('--replace-photos');

const TENANT_ID = (() => {
  const m = process.argv.find((a) => a.startsWith('--tenant-id='));
  if (m) return m.split('=').slice(1).join('=').trim();
  return process.env.TENANT_ID || 'mosc_malankara_orthodox_2';
})();

const TERM_YEAR = (() => {
  const m = process.argv.find((a) => a.startsWith('--term-year='));
  if (m) return parseInt(m.split('=')[1], 10) || 2026;
  return parseInt(process.env.TERM_YEAR || '2026', 10) || 2026;
})();

const MIN_SCORE = (() => {
  const m = process.argv.find((a) => a.startsWith('--min-score='));
  if (m) {
    const v = parseFloat(m.split('=')[1]);
    return Number.isFinite(v) ? v : 0.75;
  }
  const env = parseFloat(process.env.MIN_SCORE || '');
  return Number.isFinite(env) ? env : 0.75;
})();

/** Priority-ordered image sources (higher = preferred when scores tie). */
const SOURCE_PRIORITY = [
  {
    uid: 'api::holy-synod-member.holy-synod-member',
    mediaField: 'image',
    label: 'holy-synod-member',
    populate: { image: true },
  },
  {
    uid: 'api::bishop.bishop',
    mediaField: 'image',
    label: 'bishop',
    populate: { image: true, diocese: true },
  },
  {
    uid: 'api::diocesan-bishop.diocesan-bishop',
    mediaField: 'image',
    label: 'diocesan-bishop',
    populate: { image: true, diocese: true },
  },
  {
    uid: 'api::priest.priest',
    mediaField: 'image',
    label: 'priest',
    populate: { image: true, diocese: true },
  },
  {
    uid: 'api::managing-committee.managing-committee',
    mediaField: 'image',
    label: 'managing-committee',
    populate: { image: true },
  },
  {
    uid: 'api::working-committee.working-committee',
    mediaField: 'image',
    label: 'working-committee',
    populate: { image: true },
  },
];

const TITLE_STRIP_RE =
  /\b(?:h\.?\s*h\.?|h\.?\s*b\.?|h\.?\s*g\.?|his\s+holiness|his\s+beatitude|his\s+grace|metropolitan|catholicos|most\s+rev\.?|very\s+rev\.?|v\.?\s*rev\.?|rev\.?\s*fr\.?|rev\.?|fr\.?|cor\s+episcopa|corepiscopa|sri\.?|adv\.?|dr\.?|mr\.?|mrs\.?|ms\.?|prof\.?)\b/gi;

const STOP_TOKENS = new Set([
  'mar',
  'of',
  'the',
  'and',
  'diocese',
  'parish',
  'orthodox',
  'syrian',
  'church',
  'malankara',
]);

function tenantFilter(tenant) {
  const docId = tenant.documentId ?? tenant.document_id;
  return {
    $or: [{ tenant: tenant.id }, ...(docId ? [{ tenant: { documentId: docId } }] : [])],
  };
}

function asList(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  return result.results ?? result.data ?? [];
}

function mediaDocumentId(media) {
  if (!media) return null;
  if (typeof media === 'string' || typeof media === 'number') return String(media);
  return media.documentId ?? media.document_id ?? null;
}

function mediaUrl(media) {
  if (!media || typeof media !== 'object') return null;
  return media.url || null;
}

function stripTitles(name) {
  return String(name || '')
    .replace(TITLE_STRIP_RE, ' ')
    .replace(/\([^)]*\)/g, ' ');
}

function normalizeName(name) {
  return stripTitles(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameTokens(normalized) {
  return normalized
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOP_TOKENS.has(t));
}

function lastToken(tokens) {
  return tokens.length ? tokens[tokens.length - 1] : '';
}

function normalizeDiocese(value) {
  if (!value) return '';
  if (typeof value === 'object') {
    return normalizeName(value.name || value.title || '');
  }
  return normalizeName(String(value).replace(/^diocese\s+of\s+/i, ''));
}

function inferPersonKind(name, role) {
  const r = String(role || '').toLowerCase();
  const n = String(name || '');
  if (
    /metropolitan|catholicos|president|vice\s*president/i.test(r) ||
    /\bH\.?\s*[HBG]\.?\b/i.test(n) ||
    /\bMar\b/.test(n)
  ) {
    return 'clergy-bishop';
  }
  if (
    /priest/i.test(r) ||
    /\bRev\.?\s*Fr\b/i.test(n) ||
    /\bFr\./i.test(n) ||
    /cor\s*episcopa/i.test(n) ||
    /\bV\.?\s*Rev\b/i.test(n)
  ) {
    return 'clergy-priest';
  }
  if (/^adv\.|^sri\.|^dr\.|^mr\./i.test(n.trim()) || /lay/i.test(r)) {
    return 'lay';
  }
  return 'unknown';
}

function sourceKind(label) {
  if (label === 'holy-synod-member' || label === 'bishop' || label === 'diocesan-bishop') {
    return 'clergy-bishop';
  }
  if (label === 'priest') return 'clergy-priest';
  if (label === 'managing-committee' || label === 'working-committee') return 'directory';
  return 'unknown';
}

/** Soft spelling variants for episcopal / Malayalam name forms. */
function expandTokenVariants(token) {
  const t = String(token || '').toLowerCase();
  const out = new Set([t]);
  const pairs = [
    ['timothios', 'thimothios'],
    ['timotheos', 'thimothios'],
    ['chrysostomos', 'chrysostamus'],
    ['chrysostom', 'chrysostamus'],
    ['epiphanios', 'ephiphanios'],
    ['epiphanius', 'ephiphanios'],
    ['geevarghese', 'geevarughese'],
    ['varghese', 'varughese'],
    ['mathews', 'mathew'],
    ['yuhanon', 'yoohanon'],
    ['yuhannan', 'yoohanon'],
  ];
  for (const [a, b] of pairs) {
    if (t === a) out.add(b);
    if (t === b) out.add(a);
  }
  return out;
}

function tokensOverlapSoft(aTokens, bTokens) {
  const bExpanded = new Set();
  for (const t of bTokens) {
    for (const v of expandTokenVariants(t)) bExpanded.add(v);
  }
  return aTokens.filter((t) => {
    for (const v of expandTokenVariants(t)) {
      if (bExpanded.has(v)) return true;
    }
    return false;
  });
}

/**
 * Score overlap between MC member and a source candidate.
 * Requires last-name match + a non-last distinctive given token for fuzzy hits.
 */
function scoreMatch(mcNorm, mcTokens, mcDioceseNorm, candidate, mcKind) {
  const cNorm = candidate.normName;
  const cTokens = candidate.tokens;
  if (!mcNorm || !cNorm || !mcTokens.length || !cTokens.length) {
    return { score: 0, reason: 'empty' };
  }

  const srcKind = sourceKind(candidate.label);
  const crossRoleBlocked =
    (mcKind === 'lay' && (srcKind === 'clergy-priest' || srcKind === 'clergy-bishop')) ||
    (mcKind === 'clergy-bishop' && srcKind === 'clergy-priest') ||
    (mcKind === 'clergy-priest' && srcKind === 'clergy-bishop');

  if (mcNorm === cNorm) {
    // Exact lay↔priest names are ambiguous (common Malayalam names)
    if (mcKind === 'lay' && srcKind === 'clergy-priest') {
      return { score: 0, reason: 'cross-role-exact' };
    }
    return { score: 1, reason: 'exact' };
  }

  const softShared = tokensOverlapSoft(mcTokens, cTokens);
  if (
    softShared.length >= 2 &&
    softShared.length === Math.max(mcTokens.length, cTokens.length) &&
    !(mcKind === 'lay' && srcKind === 'clergy-priest')
  ) {
    return { score: 0.98, reason: 'soft-exact' };
  }

  const mcLast = lastToken(mcTokens);
  const cLast = lastToken(cTokens);
  const lastVariantsOk = [...expandTokenVariants(mcLast)].some((v) =>
    expandTokenVariants(cLast).has(v)
  );
  const lastOk =
    mcLast && cLast && (lastVariantsOk || mcLast.includes(cLast) || cLast.includes(mcLast));

  if (!lastOk && softShared.filter((t) => t.length >= 4).length < 1) {
    return { score: 0, reason: 'no-lastname' };
  }

  const nonLastShared = softShared.filter((t) => {
    const isLast = expandTokenVariants(mcLast).has(t) || expandTokenVariants(cLast).has(t);
    return !isLast && t.length >= 3;
  });
  if (!nonLastShared.length) {
    return { score: 0, reason: 'no-given' };
  }

  if (crossRoleBlocked) {
    return { score: 0, reason: 'cross-role' };
  }

  const union = new Set([...mcTokens, ...cTokens]);
  let jaccard = union.size ? softShared.length / union.size : 0;

  if (lastOk && lastVariantsOk) jaccard = Math.min(1, jaccard + 0.15);
  if (nonLastShared.some((t) => t.length >= 6)) jaccard = Math.min(1, jaccard + 0.1);

  if (mcDioceseNorm && candidate.dioceseNorm) {
    if (mcDioceseNorm === candidate.dioceseNorm) jaccard = Math.min(1, jaccard + 0.12);
    else jaccard = Math.max(0, jaccard - 0.08);
  }

  if (mcKind === 'clergy-bishop' && srcKind === 'clergy-bishop') {
    jaccard = Math.min(1, jaccard + 0.05);
  }

  return { score: jaccard, reason: lastOk ? 'token-overlap' : 'shared-tokens' };
}

function downloadToTemp(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(
      url,
      {
        headers: { 'User-Agent': 'MOSC-EnrichMCPhotos/1.0' },
        rejectUnauthorized: false,
        timeout: 30000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          downloadToTemp(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const extGuess = (path.extname(new URL(url, 'http://localhost').pathname) || '.jpg').split('?')[0];
          const ext = extGuess.length <= 5 ? extGuess : '.jpg';
          const tmp = path.join(os.tmpdir(), `mc-photo-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
          fs.writeFileSync(tmp, buf);
          resolve(tmp);
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout downloading ${url}`));
    });
  });
}

function resolveLocalMediaPath(url) {
  if (!url || typeof url !== 'string') return null;
  if (/^https?:\/\//i.test(url)) return null;
  const rel = url.replace(/^\//, '').replace(/\//g, path.sep);
  const candidates = [
    path.join(process.cwd(), 'public', rel),
    path.join(process.cwd(), rel),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

async function getUploadFileDocumentId(strapi, uploaded) {
  if (!uploaded) return null;
  if (uploaded.documentId) return uploaded.documentId;
  if (uploaded.id) {
    const row = await strapi.db.query('plugin::upload.file').findOne({
      where: { id: uploaded.id },
      select: ['documentId', 'document_id'],
    });
    return row?.documentId ?? row?.document_id ?? null;
  }
  return null;
}

async function uploadLocalImage(strapi, filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const stats = fs.statSync(filePath);
    const ext = path.extname(filePath).slice(1) || 'jpg';
    const mimetype = mime.lookup(ext) || 'image/jpeg';
    const name = path.basename(filePath, path.extname(filePath));
    const [uploaded] = await strapi.plugin('upload').service('upload').upload({
      data: { fileInfo: { name, alternativeText: name, caption: name } },
      files: {
        filepath: filePath,
        originalFileName: path.basename(filePath),
        size: stats.size,
        mimetype,
      },
    });
    const documentId = await getUploadFileDocumentId(strapi, uploaded);
    return documentId != null ? { documentId } : null;
  } catch (e) {
    console.warn('  Upload failed:', path.basename(filePath), e.message);
    return null;
  }
}

async function setMediaRelationViaDb(strapi, entityDocumentId, fileDocumentId, fieldName = 'photo') {
  try {
    const entityRow = await strapi.db.query(UID).findOne({
      where: { documentId: entityDocumentId },
      select: ['id'],
    });
    const fileRow = await strapi.db.query('plugin::upload.file').findOne({
      where: { documentId: fileDocumentId },
      select: ['id'],
    });
    if (!entityRow?.id || !fileRow?.id) return false;
    const db = strapi.db.connection;
    const morphTable = 'files_related_mph';
    await db(morphTable)
      .where({ related_id: entityRow.id, related_type: UID, field: fieldName })
      .del();
    await db(morphTable).insert({
      file_id: fileRow.id,
      related_id: entityRow.id,
      related_type: UID,
      field: fieldName,
      order: 1,
    });
    return true;
  } catch (e) {
    console.warn('  DB media link failed:', e.message);
    return false;
  }
}

async function attachPhoto(strapi, mcDocumentId, fileDocumentId) {
  try {
    await strapi.documents(UID).update({
      documentId: mcDocumentId,
      data: { photo: { connect: [{ documentId: fileDocumentId }] } },
    });
  } catch (_) {
    // Expected on Strapi 5 for media — fall through to morph table
  }
  return setMediaRelationViaDb(strapi, mcDocumentId, fileDocumentId, 'photo');
}

async function resolveFileDocumentId(strapi, media) {
  const existingId = mediaDocumentId(media);
  if (existingId) return { documentId: existingId, reused: true };

  const url = mediaUrl(media);
  if (!url) return null;

  let tmpPath = null;
  let cleanup = false;
  try {
    const local = resolveLocalMediaPath(url);
    if (local) {
      tmpPath = local;
    } else {
      let absolute = url;
      if (url.startsWith('/')) {
        const base = process.env.STRAPI_URL || process.env.PUBLIC_URL || 'http://127.0.0.1:1337';
        absolute = `${base.replace(/\/$/, '')}${url}`;
      }
      tmpPath = await downloadToTemp(absolute);
      cleanup = true;
    }
    const uploaded = await uploadLocalImage(strapi, tmpPath);
    if (!uploaded?.documentId) return null;
    return { documentId: uploaded.documentId, reused: false };
  } finally {
    if (cleanup && tmpPath && fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch (_) {}
    }
  }
}

function buildCandidate(row, source, priorityIndex) {
  const media = row[source.mediaField];
  if (!media) return null;
  const fileId = mediaDocumentId(media);
  const url = mediaUrl(media);
  if (!fileId && !url) return null;

  const normName = normalizeName(row.name);
  const tokens = nameTokens(normName);
  if (!tokens.length) return null;

  let dioceseNorm = '';
  if (row.diocese) dioceseNorm = normalizeDiocese(row.diocese);
  else if (row.address) {
    const m = String(row.address).match(/diocese\s+of\s+([^\n,]+)/i);
    if (m) dioceseNorm = normalizeDiocese(m[1]);
  }

  return {
    uid: source.uid,
    label: source.label,
    priorityIndex,
    slug: row.slug || null,
    name: row.name,
    normName,
    tokens,
    dioceseNorm,
    media,
    fileId,
    url,
  };
}

function findBestMatch(mc, candidates) {
  const mcNorm = normalizeName(mc.name);
  const mcTokens = nameTokens(mcNorm);
  const mcDioceseNorm = normalizeDiocese(mc.diocese);
  const mcKind = inferPersonKind(mc.name, mc.role);
  let best = null;

  for (const c of candidates) {
    const { score, reason } = scoreMatch(mcNorm, mcTokens, mcDioceseNorm, c, mcKind);
    if (score < MIN_SCORE) continue;
    if (
      !best ||
      score > best.score + 0.001 ||
      (Math.abs(score - best.score) < 0.001 && c.priorityIndex < best.candidate.priorityIndex)
    ) {
      best = { score, reason, candidate: c };
    }
  }
  return best;
}

async function loadTenant(strapi, tenantId) {
  const found = await strapi.documents('api::tenant.tenant').findMany({
    filters: { tenantId },
    limit: 1,
  });
  const list = asList(found);
  if (!list[0]) throw new Error(`Tenant not found: ${tenantId}`);
  return list[0];
}

function memberBelongsToTenant(row, tenant, tenantId) {
  const t = row.tenant;
  if (t) {
    const tid = t.tenantId ?? t.tenant_id;
    const docId = t.documentId ?? t.document_id;
    if (tid && tid === tenantId) return true;
    if (docId && (docId === tenant.documentId || docId === tenant.document_id)) return true;
    if (t.id != null && Number(t.id) === Number(tenant.id)) return true;
  }
  // Import sometimes left tenant unlink; mo2 rows use -mo2 slug suffix
  if (tenantId === 'mosc_malankara_orthodox_2') {
    return String(row.slug || '').endsWith('-mo2');
  }
  // Other tenants: accept null-tenant only when slug does not look like mo2
  if (!t) return !String(row.slug || '').endsWith('-mo2');
  return false;
}

async function ensureTenantLink(strapi, row, tenant) {
  if (row.tenant?.id || row.tenant?.documentId) return;
  try {
    await strapi.db.query(UID).update({
      where: { documentId: row.documentId },
      data: { tenant: tenant.id },
    });
  } catch (_) {}
}

async function loadSourceCandidates(strapi, tenant) {
  const candidates = [];
  const filters = tenantFilter(tenant);

  for (let i = 0; i < SOURCE_PRIORITY.length; i++) {
    const source = SOURCE_PRIORITY[i];
    let rows = [];
    try {
      const result = await strapi.documents(source.uid).findMany({
        filters,
        populate: source.populate,
        limit: 5000,
      });
      rows = asList(result);
    } catch (e) {
      console.warn(`  Skip source ${source.label}: ${e.message}`);
      continue;
    }

    let withImage = 0;
    for (const row of rows) {
      const c = buildCandidate(row, source, i);
      if (c) {
        candidates.push(c);
        withImage++;
      }
    }
    console.log(`  ${source.label}: ${rows.length} row(s), ${withImage} with image`);
  }
  return candidates;
}

async function main() {
  console.log('Enrich MC member photos from existing Strapi media');
  console.log('  Tenant:', TENANT_ID);
  console.log('  Term year:', TERM_YEAR);
  console.log('  Dry run:', DRY_RUN);
  console.log('  Replace photos:', REPLACE_PHOTOS);
  console.log('  Min score:', MIN_SCORE);
  console.log('');

  const prevNodeEnv = process.env.NODE_ENV;
  if (!process.env.STRAPI_IMPORT_NODE_ENV) {
    process.env.NODE_ENV = 'staging';
  }

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const app = await createStrapi(await compileStrapi()).load();
  if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
  app.log.level = 'error';

  const tenant = await loadTenant(app, TENANT_ID);
  console.log('Loaded tenant id=', tenant.id, 'documentId=', tenant.documentId);

  // Load by termYear; filter tenant in JS so null-tenant -mo2 imports are included
  const mcResult = await app.documents(UID).findMany({
    filters: { termYear: TERM_YEAR },
    populate: { photo: true, tenant: true },
    limit: 2000,
  });
  const allForYear = asList(mcResult);
  const members = allForYear.filter((m) => memberBelongsToTenant(m, tenant, TENANT_ID));
  console.log(
    `MC members (termYear=${TERM_YEAR}): ${members.length} for tenant (of ${allForYear.length} total)`
  );
  if (!members.length) {
    console.warn('No MC members found for this tenant/term — nothing to enrich.');
    await app.destroy();
    process.exit(0);
  }

  console.log('Loading image sources…');
  const candidates = await loadSourceCandidates(app, tenant);
  console.log(`Total candidates with media: ${candidates.length}`);
  console.log('');

  const stats = {
    linked: 0,
    wouldLink: 0,
    skippedHasPhoto: 0,
    unmatched: 0,
    lowConfidence: 0,
    failed: 0,
  };
  const matchRows = [];
  const unmatched = [];
  const lowConfidence = [];

  for (const mc of members) {
    const hasPhoto = Boolean(mediaDocumentId(mc.photo) || mediaUrl(mc.photo));
    if (hasPhoto && !REPLACE_PHOTOS) {
      stats.skippedHasPhoto++;
      continue;
    }

    const best = findBestMatch(mc, candidates);
    if (!best) {
      // Collect near-misses for logging
      const mcNorm = normalizeName(mc.name);
      const mcTokens = nameTokens(mcNorm);
      const mcDioceseNorm = normalizeDiocese(mc.diocese);
      const mcKind = inferPersonKind(mc.name, mc.role);
      let near = null;
      for (const c of candidates) {
        const r = scoreMatch(mcNorm, mcTokens, mcDioceseNorm, c, mcKind);
        if (!near || r.score > near.score) near = { ...r, candidate: c };
      }
      if (near && near.score >= 0.4) {
        lowConfidence.push({
          mc: mc.name,
          slug: mc.slug,
          score: near.score.toFixed(3),
          source: near.candidate.label,
          sourceName: near.candidate.name,
          reason: near.reason,
        });
        stats.lowConfidence++;
      } else {
        unmatched.push({ mc: mc.name, slug: mc.slug, role: mc.role || '', diocese: mc.diocese || '' });
        stats.unmatched++;
      }
      continue;
    }

    const row = {
      mc: mc.name,
      slug: mc.slug,
      score: best.score.toFixed(3),
      reason: best.reason,
      sourceUid: best.candidate.uid,
      sourceSlug: best.candidate.slug || '-',
      sourceName: best.candidate.name,
      mediaId: best.candidate.fileId || '(url-only)',
    };
    matchRows.push(row);

    if (DRY_RUN) {
      stats.wouldLink++;
      console.log(
        `MATCH  ${mc.name}  →  ${best.candidate.label}/${best.candidate.slug || '-'}  score=${row.score}  media=${row.mediaId}`
      );
      continue;
    }

    try {
      await ensureTenantLink(app, mc, tenant);
      const resolved = await resolveFileDocumentId(app, best.candidate.media);
      if (!resolved?.documentId) {
        console.warn(`FAIL   ${mc.name}: could not resolve media documentId`);
        stats.failed++;
        continue;
      }
      const ok = await attachPhoto(app, mc.documentId, resolved.documentId);
      if (ok) {
        stats.linked++;
        console.log(
          `LINKED ${mc.name}  ←  ${best.candidate.label}/${best.candidate.slug || '-'}  (${resolved.reused ? 'reuse' : 're-upload'}) score=${row.score}`
        );
      } else {
        stats.failed++;
        console.warn(`FAIL   ${mc.name}: media attach returned false`);
      }
    } catch (e) {
      stats.failed++;
      console.warn(`FAIL   ${mc.name}:`, e.message);
    }
  }

  console.log('');
  console.log('--- Summary ---');
  console.log(`  Members:           ${members.length}`);
  console.log(`  Skipped (has photo): ${stats.skippedHasPhoto}`);
  if (DRY_RUN) console.log(`  Would link:        ${stats.wouldLink}`);
  else console.log(`  Linked:            ${stats.linked}`);
  console.log(`  Unmatched:         ${stats.unmatched}`);
  console.log(`  Low-confidence:    ${stats.lowConfidence}`);
  console.log(`  Failed:            ${stats.failed}`);

  if (matchRows.length && DRY_RUN) {
    console.log('');
    console.log('Match table (MC name → source UID/slug → media id):');
    for (const r of matchRows) {
      console.log(
        `  ${r.mc} | ${r.sourceUid} | ${r.sourceSlug} | media=${r.mediaId} | score=${r.score} (${r.reason})`
      );
    }
  }

  if (lowConfidence.length) {
    console.log('');
    console.log('Low-confidence near-misses (below min-score, not linked):');
    for (const r of lowConfidence.slice(0, 40)) {
      console.log(
        `  ${r.mc} ≈ ${r.sourceName} [${r.source}] score=${r.score} (${r.reason})`
      );
    }
    if (lowConfidence.length > 40) console.log(`  ... +${lowConfidence.length - 40} more`);
  }

  if (unmatched.length) {
    console.log('');
    console.log('Unmatched (no usable candidate):');
    for (const r of unmatched.slice(0, 40)) {
      console.log(`  ${r.mc} | ${r.role || '-'} | ${r.diocese || '-'}`);
    }
    if (unmatched.length > 40) console.log(`  ... +${unmatched.length - 40} more`);
  }

  // PDF embedded-image extraction intentionally omitted (unreliable); prefer existing media.
  console.log('');
  console.log(
    'Note: PDF embedded portraits are not used (unreliable). Unmatched rows need manual photos or --photo-dir on the import script.'
  );

  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
