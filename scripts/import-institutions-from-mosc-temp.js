'use strict';

/**
 * Import Directory – Institutions from mosc-temp institution pages.
 * Parses category hub + per-category TSX arrays (schools, hospitals, etc.).
 *
 * Sources:
 *   - institutions/page.tsx hub cards
 *   - institutions/<category>/page.tsx institution lists
 *   - public/images/institutions/*
 *
 * Env:
 *   MOSC_TEMP_DIR  (default: C:\project_workspace\mosc-temp)
 *   TENANT_ID      (default: tenant_demo_002)
 *   DRY_RUN=1      Preview only
 *   --replace      Delete ALL institutions for tenant, then import fresh
 *   --tenant-id=   Override tenant
 *
 *   npm run import:institutions -- --tenant-id=tenant_demo_002 --replace
 */

try {
  require('dotenv').config();
} catch (_) {}

const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const { normalizeSlug } = require('../src/utils/normalize-slug');

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const REPLACE = process.argv.includes('--replace');
const TENANT_ID = (() => {
  const m = process.argv.find((a) => a.startsWith('--tenant-id='));
  if (m) return m.split('=')[1].trim();
  return process.env.TENANT_ID || 'tenant_demo_002';
})();

const MOSC_ROOT = path.resolve(
  process.env.MOSC_TEMP_DIR || process.env.STRAPI_DATA_IMPORT_MOSC_TEMP_DIR || 'C:\\project_workspace\\mosc-temp'
);
const INSTITUTIONS_PAGES = path.join(MOSC_ROOT, 'src', 'app', 'mosc-redesign', '(syro)', 'institutions');
const PUBLIC_INSTITUTIONS = path.join(MOSC_ROOT, 'public', 'images', 'institutions');

const UID = 'api::institution.institution';

const CATEGORY_SLUGS = [
  'major-centres',
  'monasteries',
  'convents',
  'orphanages',
  'hospitals',
  'medical-college',
  'engineering-colleges',
  'moc-colleges',
  'schools',
];

function unescapeJsString(s) {
  if (!s) return '';
  return s.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, '\n').trim();
}

function extractBalanced(s, openIdx, openChar, closeChar) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === openChar) depth++;
    else if (s[i] === closeChar) {
      depth--;
      if (depth === 0) return s.slice(openIdx, i + 1);
    }
  }
  return null;
}

function readQuotedField(objStr, field) {
  const re = new RegExp(`${field}:\\s*(['"])((?:\\\\.|(?!\\1)[^])*)\\1`);
  const m = objStr.match(re);
  return m ? unescapeJsString(m[2]) : null;
}

function readStringArray(objStr, field) {
  const re = new RegExp(`${field}:\\s*\\[([\\s\\S]*?)\\]`);
  const m = objStr.match(re);
  if (!m) return [];
  const items = [];
  const itemRe = /(['"])((?:\\.|(?!\1)[^])*)\1/g;
  let im;
  while ((im = itemRe.exec(m[1])) !== null) {
    const val = unescapeJsString(im[2]);
    if (val) items.push(val);
  }
  return items;
}

function readContactBlock(objStr) {
  const idx = objStr.indexOf('contact:');
  if (idx < 0) return null;
  const braceStart = objStr.indexOf('{', idx);
  if (braceStart < 0) return null;
  const block = extractBalanced(objStr, braceStart, '{', '}');
  if (!block) return null;
  const phone = readQuotedField(block, 'phone');
  const fax = readQuotedField(block, 'fax');
  const website = readQuotedField(block, 'website');
  const emails = readStringArray(block, 'emails');
  const addressLines = readStringArray(block, 'address');
  const phones = [phone, fax].filter(Boolean).join(', ') || null;
  return {
    address: addressLines.length ? addressLines.join('\n') : null,
    email: emails.length ? emails.join(', ') : null,
    phones,
    website: website || null,
  };
}

function buildRichDescription(objStr) {
  const parts = [];
  const description = readQuotedField(objStr, 'description');
  const mission = readQuotedField(objStr, 'mission');
  const facilities = readQuotedField(objStr, 'facilities');
  const spiritualNote = readQuotedField(objStr, 'spiritualNote');
  const programs = readStringArray(objStr, 'programs');
  if (description) parts.push(description);
  if (mission) parts.push(`Mission: ${mission}`);
  if (programs.length) parts.push(`Programs: ${programs.join(', ')}`);
  if (facilities) parts.push(facilities);
  if (spiritualNote) parts.push(spiritualNote);
  return parts.length ? parts.join('\n\n') : null;
}

function parseInstitutionObject(objStr) {
  const name = readQuotedField(objStr, 'name');
  if (!name) return null;

  const location = readQuotedField(objStr, 'location');
  const phone = readQuotedField(objStr, 'phone');
  const email = readQuotedField(objStr, 'email');
  const contact = readContactBlock(objStr);

  return {
    name,
    address: contact?.address || location || null,
    phones: contact?.phones || phone || null,
    email: contact?.email || email || null,
    website: contact?.website || null,
    description: buildRichDescription(objStr),
  };
}

function extractAllArrayBlocks(raw) {
  const blocks = [];
  const seenStarts = new Set();
  const patterns = [
    /const\s+\w+\s*=\s*\[/g,
    /const\s+\w+\s*:\s*[^=]+=\s*\[/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(raw)) !== null) {
      const eqIdx = raw.indexOf('=', m.index);
      if (eqIdx < 0) continue;
      const openIdx = raw.indexOf('[', eqIdx);
      if (openIdx < 0 || seenStarts.has(openIdx)) continue;
      seenStarts.add(openIdx);
      const inner = extractBalanced(raw, openIdx, '[', ']');
      if (inner) blocks.push(inner.slice(1, -1));
    }
  }
  return blocks;
}

function parseObjectsFromArrayContent(content) {
  const rows = [];
  let i = 0;
  while (i < content.length) {
    const objStart = content.indexOf('{', i);
    if (objStart < 0) break;
    const objFull = extractBalanced(content, objStart, '{', '}');
    if (!objFull) break;
    const parsed = parseInstitutionObject(objFull);
    if (parsed) rows.push(parsed);
    i = objStart + objFull.length;
  }
  return rows;
}

function loadHubMeta() {
  const hubPath = path.join(INSTITUTIONS_PAGES, 'page.tsx');
  if (!fs.existsSync(hubPath)) return new Map();
  const raw = fs.readFileSync(hubPath, 'utf8');
  const map = new Map();
  let order = 0;

  for (const line of raw.split('\n')) {
    if (!line.includes("id: '") || !line.includes('link:')) continue;
    const idM = line.match(/id:\s*'([^']+)'/);
    const titleM = line.match(/title:\s*'((?:\\'|[^'])*)'/);
    const descM = line.match(/description:\s*'((?:\\'|[^'])*)'/);
    const imageM = line.match(/image:\s*'([^']+)'/);
    if (!idM) continue;
    map.set(idM[1], {
      title: titleM ? unescapeJsString(titleM[1]) : idM[1],
      description: descM ? unescapeJsString(descM[1]).slice(0, 500) : null,
      image: imageM?.[1] || null,
      order: order++,
    });
  }
  return map;
}

function parsePageIntro(raw) {
  const m = raw.match(/className="font-syro-primary text-lg text-syro-dark-gray leading-relaxed[^"]*"[^>]*>\s*([\s\S]*?)<\/p>/);
  if (!m) return null;
  return m[1].replace(/&apos;/g, "'").replace(/<[^>]+>/g, '').trim() || null;
}

function parseFeaturedImage(raw) {
  const m = raw.match(/<Image[^>]+src="(\/images\/institutions\/[^"]+)"/);
  return m?.[1] || null;
}

function parseMedicalCollegePage(raw, hub) {
  const h2M = raw.match(/font-semibold text-3xl text-syro-blue mb-6">\s*([\s\S]*?)<\/h2>/);
  const locM = raw.match(/text-lg text-syro-blue mb-6">\s*([\s\S]*?)<\/p>/);
  const phoneLines = [];
  const deptRe = /<span className="font-medium">([^<]+)<\/span>\s*<span>([^<]+)<\/span>/g;
  let dm;
  while ((dm = deptRe.exec(raw)) !== null) {
    const label = dm[1].replace(/:$/, '').trim();
    const number = dm[2].trim();
    if (number) phoneLines.push(`${label}: ${number}`);
  }
  if (phoneLines.length === 0) {
    const spanRe = /<span>([\d\s]+)<\/span>/g;
    let sm;
    while ((sm = spanRe.exec(raw)) !== null) {
      const digits = sm[1].trim();
      if (digits.length >= 8) phoneLines.push(digits);
    }
  }
  const websiteM = raw.match(/href="(https?:\/\/[^"]+)"/);
  const intro = parsePageIntro(raw) || hub?.description || null;
  const description = [intro, phoneLines.length ? `Contact numbers:\n${phoneLines.join('\n')}` : null]
    .filter(Boolean)
    .join('\n\n');
  return [
    {
      name: h2M?.[1]?.trim() || hub?.title || 'Malankara Medical Mission Hospital',
      address: locM?.[1]?.trim() || 'Kolencherry – 682 311',
      phones: phoneLines.length ? phoneLines.join(', ') : null,
      website: websiteM?.[1] || 'http://moscmm.org/',
      description: description || null,
    },
  ];
}

function parseCategoryPage(categorySlug, raw, hub) {
  if (categorySlug === 'medical-college') {
    return parseMedicalCollegePage(raw, hub);
  }

  const rows = [];
  for (const block of extractAllArrayBlocks(raw)) {
    rows.push(...parseObjectsFromArrayContent(block));
  }

  if (rows.length === 0 && hub) {
    rows.push({
      name: hub.title,
      address: null,
      phones: null,
      email: null,
      website: null,
      description: hub.description || parsePageIntro(raw),
    });
  }

  return rows;
}

function resolveImageFile(imageRef) {
  if (!imageRef || typeof imageRef !== 'string') return null;
  const ref = imageRef.trim();
  const base = path.basename(ref);
  const candidates = [
    path.join(PUBLIC_INSTITUTIONS, base),
    path.join(MOSC_ROOT, 'public', ref.replace(/^\//, '').replace(/\//g, path.sep)),
  ];
  if (fs.existsSync(PUBLIC_INSTITUTIONS)) {
    try {
      for (const name of fs.readdirSync(PUBLIC_INSTITUTIONS)) {
        if (name.toLowerCase() === base.toLowerCase()) candidates.push(path.join(PUBLIC_INSTITUTIONS, name));
      }
    } catch (_) {}
  }
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch (_) {}
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
    console.warn('  Image upload failed:', path.basename(filePath), e.message);
    return null;
  }
}

async function setMediaRelationViaDb(strapi, entityDocumentId, fileDocumentId) {
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
    await db(morphTable).where({ related_id: entityRow.id, related_type: UID, field: 'image' }).del();
    await db(morphTable).insert({
      file_id: fileRow.id,
      related_id: entityRow.id,
      related_type: UID,
      field: 'image',
      order: 1,
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function getOrCreateTenant(strapi, tenantId) {
  const existing = await strapi.db.query('api::tenant.tenant').findOne({
    where: { tenantId },
    select: ['id', 'documentId', 'document_id'],
  });
  if (existing) {
    return { id: existing.id, documentId: existing.documentId ?? existing.document_id ?? existing.id };
  }
  const created = await strapi.documents('api::tenant.tenant').create({
    data: {
      name: 'MOSC Demo',
      tenantId,
      slug: tenantId,
      domain: 'mosc.in',
      description: 'Malankara Orthodox Syrian Church',
    },
  });
  return { id: created.id, documentId: created.documentId ?? created.document_id ?? created.id };
}

async function deleteTenantInstitutions(strapi, tenant) {
  const existing = await strapi.documents(UID).findMany({
    filters: { tenant: tenant.id },
    limit: 10000,
  });
  const list = existing?.results ?? existing?.data ?? (Array.isArray(existing) ? existing : []);
  let deleted = 0;
  for (const row of list) {
    const docId = row.documentId ?? row.document_id;
    if (!docId) continue;
    try {
      await strapi.documents(UID).delete({ documentId: docId });
      deleted++;
    } catch (e) {
      console.warn('  Delete failed:', docId, e.message);
    }
  }
  return deleted;
}

function makeUniqueSlug(categorySlug, name, address, usedSlugs) {
  let base = normalizeSlug(`${categorySlug}-${name}`);
  if (usedSlugs.has(base) && address) {
    const loc = normalizeSlug(String(address).split(/[,–—-]/)[0].slice(0, 40));
    if (loc) base = `${base}-${loc}`;
  }
  let slug = base || normalizeSlug(name) || categorySlug;
  let n = 2;
  while (usedSlugs.has(slug)) {
    slug = `${base}-${n++}`;
  }
  usedSlugs.add(slug);
  return slug;
}

let app;

async function main() {
  console.log('Institutions import from mosc-temp');
  console.log('  MOSC_ROOT:', MOSC_ROOT);
  console.log('  TENANT_ID:', TENANT_ID);
  if (DRY_RUN) console.log('  DRY_RUN=1');
  if (REPLACE) console.log('  --replace: delete all tenant institutions, then import fresh');
  console.log('');

  if (!fs.existsSync(MOSC_ROOT)) {
    console.error('MOSC_TEMP_DIR not found:', MOSC_ROOT);
    process.exit(1);
  }

  const hubMeta = loadHubMeta();
  const allRecords = [];
  for (const categorySlug of CATEGORY_SLUGS) {
    const pagePath = path.join(INSTITUTIONS_PAGES, categorySlug, 'page.tsx');
    if (!fs.existsSync(pagePath)) {
      console.warn('Skip (missing page):', categorySlug);
      continue;
    }
    const raw = fs.readFileSync(pagePath, 'utf8');
    const hub = hubMeta.get(categorySlug) || { title: categorySlug, order: CATEGORY_SLUGS.indexOf(categorySlug) };
    const imageRef = parseFeaturedImage(raw) || hub.image;
    const rows = parseCategoryPage(categorySlug, raw, hub);
    const categoryOrder = hub.order != null ? hub.order : CATEGORY_SLUGS.indexOf(categorySlug);
    rows.forEach((row, idx) => {
      allRecords.push({
        ...row,
        categorySlug,
        categoryOrder,
        order: categoryOrder * 1000 + idx,
        imageRef,
      });
    });
    console.log(`  ${categorySlug}: ${rows.length} institutions`);
  }
  console.log('Total to import:', allRecords.length);
  console.log('');

  const prevNodeEnv = process.env.NODE_ENV;
  if (!process.env.STRAPI_IMPORT_NODE_ENV) {
    process.env.NODE_ENV = 'staging';
  }

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  app = await createStrapi(await compileStrapi()).load();
  if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
  app.log.level = 'error';

  const tenant = await getOrCreateTenant(app, TENANT_ID);

  if (REPLACE && !DRY_RUN) {
    const deleted = await deleteTenantInstitutions(app, tenant);
    console.log('Deleted existing institutions for tenant:', deleted);
  } else if (REPLACE && DRY_RUN) {
    const existing = await app.documents(UID).findMany({ filters: { tenant: tenant.id }, limit: 10000 });
    const list = existing?.results ?? existing?.data ?? (Array.isArray(existing) ? existing : []);
    console.log('Would delete', list.length, 'existing institutions for tenant');
  }

  const usedSlugs = new Set();
  let created = 0;
  let skipped = 0;
  const imageCache = new Map();

  for (const rec of allRecords) {
    const slug = makeUniqueSlug(rec.categorySlug, rec.name, rec.address, usedSlugs);
    const data = {
      name: rec.name,
      slug,
      address: rec.address,
      email: rec.email,
      phones: rec.phones,
      website: rec.website,
      description: rec.description,
      order: rec.order,
      tenant: tenant.id,
    };

    if (DRY_RUN) {
      console.log('Would import:', slug, '|', rec.name.slice(0, 60));
      created++;
      continue;
    }

    try {
      const doc = await app.documents(UID).create({ data });
      created++;
      console.log('Created:', slug);
      try {
        await app.db.query(UID).update({
          where: { documentId: doc.documentId },
          data: { tenant: tenant.id },
        });
      } catch (_) {}

      const imageFile = resolveImageFile(rec.imageRef);
      if (imageFile && doc.documentId) {
        let uploaded = imageCache.get(rec.imageRef);
        if (!uploaded) {
          uploaded = await uploadLocalImage(app, imageFile);
          if (uploaded) imageCache.set(rec.imageRef, uploaded);
        }
        if (uploaded?.documentId) {
          try {
            await app.documents(UID).update({
              documentId: doc.documentId,
              data: { image: { connect: [{ documentId: uploaded.documentId }] } },
            });
          } catch (_) {}
          await setMediaRelationViaDb(app, doc.documentId, uploaded.documentId);
        }
      }
    } catch (e) {
      console.warn('Failed:', slug, e.message);
      skipped++;
    }
  }

  console.log('');
  console.log(DRY_RUN ? 'Would create' : 'Created', created);
  console.log('Skipped', skipped);

  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  if (app) app.destroy().catch(() => {});
  process.exit(1);
});
