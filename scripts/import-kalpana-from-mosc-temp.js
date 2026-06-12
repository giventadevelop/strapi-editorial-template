'use strict';

/**
 * Import Kalpana page content and editions from mosc-temp.
 *
 * Sources:
 *   - src/app/mosc-redesign/(syro)/downloads/kalpana/page.tsx
 *   - public/images/downloads/kalpana.png, kalapana_card_logo.png
 *
 * Creates/updates:
 *   - Downloads – Kalpana Page (single type)
 *   - Downloads – Kalpana Editions (collection type)
 *
 * Env:
 *   MOSC_TEMP_DIR  (default: C:\project_workspace\mosc-temp)
 *   TENANT_ID      (default: tenant_demo_002)
 *   DRY_RUN=1      Preview only
 *   --replace      Delete all kalpana editions for tenant, then import fresh
 *   --tenant-id=   Override tenant
 *
 *   npm run import:kalpana -- --tenant-id=tenant_demo_002 --replace
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
const KALPANA_PAGE = path.join(
  MOSC_ROOT,
  'src',
  'app',
  'mosc-redesign',
  '(syro)',
  'downloads',
  'kalpana',
  'page.tsx'
);
const PUBLIC_DOWNLOADS = path.join(MOSC_ROOT, 'public', 'images', 'downloads');

const PAGE_UID = 'api::kalpana-page.kalpana-page';
const EDITION_UID = 'api::kalpana-edition.kalpana-edition';

function unescapeJsString(s) {
  if (!s) return '';
  return s.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, '\n').trim();
}

function readQuotedField(objStr, field) {
  const re = new RegExp(`${field}:\\s*(['"])((?:\\\\.|(?!\\1)[^])*)\\1`);
  const m = objStr.match(re);
  return m ? unescapeJsString(m[2]) : null;
}

function parseKalpanaEditions(raw) {
  const editions = [];
  const arrayStart = raw.indexOf('const kalpanaEditions = [');
  if (arrayStart < 0) return editions;
  const openIdx = raw.indexOf('[', arrayStart);
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < raw.length; i++) {
    if (raw[i] === '[') depth++;
    else if (raw[i] === ']') {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx < 0) return editions;

  const inner = raw.slice(openIdx + 1, closeIdx);
  let i = 0;
  while (i < inner.length) {
    const objStart = inner.indexOf('{', i);
    if (objStart < 0) break;
    let objDepth = 0;
    let objEnd = -1;
    for (let j = objStart; j < inner.length; j++) {
      if (inner[j] === '{') objDepth++;
      else if (inner[j] === '}') {
        objDepth--;
        if (objDepth === 0) {
          objEnd = j;
          break;
        }
      }
    }
    if (objEnd < 0) break;
    const objStr = inner.slice(objStart, objEnd + 1);
    const year = readQuotedField(objStr, 'year');
    const title = readQuotedField(objStr, 'title');
    const link = readQuotedField(objStr, 'link');
    const availableMatch = objStr.match(/available:\s*(true|false)/);
    if (year && title) {
      editions.push({
        year,
        title,
        externalLink: link && link !== '#' ? link : null,
        available: availableMatch ? availableMatch[1] === 'true' : true,
      });
    }
    i = objEnd + 1;
  }
  return editions;
}

function parseIntroParagraphs(raw) {
  const paragraphs = [];
  const re =
    /className="font-syro-primary text-lg text-syro-dark-gray leading-relaxed(?: mb-4)?">\s*([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const text = m[1].replace(/\s+/g, ' ').trim();
    if (text.length > 20) paragraphs.push(text);
  }
  return paragraphs.slice(0, 2);
}

function parseAboutSection(raw) {
  const aboutBlockMatch = raw.match(/About Kalpana[\s\S]*?<div className="space-y-4[^"]*">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>\s*<\/section>/);
  const block = aboutBlockMatch?.[1] || raw;

  const titleMatch = raw.match(/About Kalpana/);
  const aboutTitle = titleMatch ? 'About Kalpana' : 'About Kalpana';

  const descMatch = block.match(/<p>\s*([\s\S]*?)<\/p>/);
  const aboutDescription = descMatch?.[1]?.replace(/\s+/g, ' ').trim() || null;

  const features = [];
  const featureRe = /<span>([^<]+)<\/span>\s*<\/li>/g;
  let fm;
  while ((fm = featureRe.exec(block)) !== null) {
    const text = fm[1].replace(/\s+/g, ' ').trim();
    if (text) features.push(text);
  }

  return { aboutTitle, aboutDescription, aboutFeatures: features };
}

function parseHeroImageRef(raw) {
  const m = raw.match(/src="(\/images\/downloads\/[^"]+)"/);
  return m?.[1] || '/images/downloads/kalpana.png';
}

function parseCardImageRef(raw) {
  const m = raw.match(/kalapana_card_logo\.png|kalpana_card_logo\.png/);
  if (m) return `/images/downloads/${m[0]}`;
  return '/images/downloads/kalapana_card_logo.png';
}

function resolveImageFile(imageRef) {
  if (!imageRef || typeof imageRef !== 'string') return null;
  const ref = imageRef.trim();
  const base = path.basename(ref);
  const candidates = [
    path.join(PUBLIC_DOWNLOADS, base),
    path.join(MOSC_ROOT, 'public', ref.replace(/^\//, '').replace(/\//g, path.sep)),
  ];
  if (fs.existsSync(PUBLIC_DOWNLOADS)) {
    try {
      for (const name of fs.readdirSync(PUBLIC_DOWNLOADS)) {
        if (name.toLowerCase() === base.toLowerCase()) candidates.push(path.join(PUBLIC_DOWNLOADS, name));
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

async function uploadLocalFile(strapi, filePath, fieldName = 'image') {
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
    return documentId != null ? { documentId, fieldName } : null;
  } catch (e) {
    console.warn('  Image upload failed:', path.basename(filePath), e.message);
    return null;
  }
}

async function setMediaRelationViaDb(strapi, contentTypeUid, entityDocumentId, fileDocumentId, fieldName) {
  try {
    const entityRow = await strapi.db.query(contentTypeUid).findOne({
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
      .where({ related_id: entityRow.id, related_type: contentTypeUid, field: fieldName })
      .del();
    await db(morphTable).insert({
      file_id: fileRow.id,
      related_id: entityRow.id,
      related_type: contentTypeUid,
      field: fieldName,
      order: 1,
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function linkMedia(strapi, uid, entityDocumentId, uploaded, fieldName) {
  if (!uploaded?.documentId || !entityDocumentId) return;
  try {
    await strapi.documents(uid).update({
      documentId: entityDocumentId,
      data: { [fieldName]: { connect: [{ documentId: uploaded.documentId }] } },
    });
  } catch (_) {}
  await setMediaRelationViaDb(strapi, uid, entityDocumentId, uploaded.documentId, fieldName);
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

async function findTenantKalpanaPage(strapi, tenant) {
  const result = await strapi.documents(PAGE_UID).findMany({
    filters: { tenant: tenant.id },
    limit: 1,
  });
  const list = result?.results ?? result?.data ?? (Array.isArray(result) ? result : []);
  return list[0] || null;
}

async function deleteTenantEditions(strapi, tenant) {
  const existing = await strapi.documents(EDITION_UID).findMany({
    filters: { tenant: tenant.id },
    limit: 10000,
  });
  const list = existing?.results ?? existing?.data ?? (Array.isArray(existing) ? existing : []);
  let deleted = 0;
  for (const row of list) {
    const docId = row.documentId ?? row.document_id;
    if (!docId) continue;
    try {
      await strapi.documents(EDITION_UID).delete({ documentId: docId });
      deleted++;
    } catch (e) {
      console.warn('  Delete failed:', docId, e.message);
    }
  }
  return deleted;
}

let app;

async function main() {
  console.log('Kalpana import from mosc-temp');
  console.log('  MOSC_ROOT:', MOSC_ROOT);
  console.log('  TENANT_ID:', TENANT_ID);
  if (DRY_RUN) console.log('  DRY_RUN=1');
  if (REPLACE) console.log('  --replace: delete all tenant kalpana editions, then import fresh');
  console.log('');

  if (!fs.existsSync(MOSC_ROOT)) {
    console.error('MOSC_TEMP_DIR not found:', MOSC_ROOT);
    process.exit(1);
  }
  if (!fs.existsSync(KALPANA_PAGE)) {
    console.error('Kalpana page not found:', KALPANA_PAGE);
    process.exit(1);
  }

  const raw = fs.readFileSync(KALPANA_PAGE, 'utf8');
  const editions = parseKalpanaEditions(raw);
  const introParagraphs = parseIntroParagraphs(raw);
  const about = parseAboutSection(raw);
  const heroImageRef = parseHeroImageRef(raw);
  const cardImageRef = parseCardImageRef(raw);

  console.log('Parsed from page.tsx:');
  console.log('  Editions:', editions.length);
  console.log('  Hero image ref:', heroImageRef);
  console.log('  Card image ref:', cardImageRef);
  console.log('');

  if (DRY_RUN) {
    console.log('Page data:');
    console.log('  intro1:', introParagraphs[0]?.slice(0, 80) + '...');
    console.log('  intro2:', introParagraphs[1]?.slice(0, 80) + '...');
    console.log('  about features:', about.aboutFeatures.length);
    editions.forEach((e) => console.log('  Would import edition:', e.year, e.title));
    process.exit(0);
  }

  const prevNodeEnv = process.env.NODE_ENV;
  if (!process.env.STRAPI_IMPORT_NODE_ENV) {
    process.env.NODE_ENV = 'staging';
  }

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  app = await createStrapi(await compileStrapi()).load();
  if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
  app.log.level = 'error';

  const tenant = await getOrCreateTenant(app, TENANT_ID);

  if (REPLACE) {
    const deleted = await deleteTenantEditions(app, tenant);
    console.log('Deleted existing kalpana editions for tenant:', deleted);
  }

  const imageCache = new Map();

  async function getUploadedImage(imageRef) {
    if (imageCache.has(imageRef)) return imageCache.get(imageRef);
    const filePath = resolveImageFile(imageRef);
    if (!filePath) {
      console.warn('  Image not found:', imageRef);
      return null;
    }
    const uploaded = await uploadLocalFile(app, filePath);
    if (uploaded) imageCache.set(imageRef, uploaded);
    return uploaded;
  }

  const pageData = {
    introParagraph1: introParagraphs[0] || null,
    introParagraph2: introParagraphs[1] || null,
    aboutTitle: about.aboutTitle,
    aboutDescription: about.aboutDescription,
    aboutFeatures: about.aboutFeatures,
    tenant: tenant.id,
  };

  let pageDoc = await findTenantKalpanaPage(app, tenant);
  if (pageDoc?.documentId) {
    pageDoc = await app.documents(PAGE_UID).update({
      documentId: pageDoc.documentId,
      data: pageData,
    });
    console.log('Updated Kalpana page for tenant');
  } else {
    pageDoc = await app.documents(PAGE_UID).create({ data: pageData });
    console.log('Created Kalpana page for tenant');
    try {
      await app.db.query(PAGE_UID).update({
        where: { documentId: pageDoc.documentId },
        data: { tenant: tenant.id },
      });
    } catch (_) {}
  }

  const heroUploaded = await getUploadedImage(heroImageRef);
  if (heroUploaded && pageDoc?.documentId) {
    await linkMedia(app, PAGE_UID, pageDoc.documentId, heroUploaded, 'heroImage');
    console.log('Linked hero image');
  }

  const cardUploaded = await getUploadedImage(cardImageRef);
  let created = 0;
  let skipped = 0;

  editions.forEach((edition, idx) => {
    edition.order = editions.length - idx;
    edition.slug = normalizeSlug(`kalpana-${edition.year}`);
  });

  for (const edition of editions) {
    const data = {
      title: edition.title,
      slug: edition.slug,
      year: edition.year,
      externalLink: edition.externalLink,
      available: edition.available,
      order: edition.order,
      tenant: tenant.id,
    };

    try {
      const existing = await app.documents(EDITION_UID).findMany({
        filters: { slug: edition.slug, tenant: tenant.id },
        limit: 1,
      });
      const list = existing?.results ?? existing?.data ?? (Array.isArray(existing) ? existing : []);
      let doc;
      if (list[0]?.documentId) {
        doc = await app.documents(EDITION_UID).update({
          documentId: list[0].documentId,
          data,
        });
        console.log('Updated edition:', edition.slug);
      } else {
        doc = await app.documents(EDITION_UID).create({ data });
        console.log('Created edition:', edition.slug);
        try {
          await app.db.query(EDITION_UID).update({
            where: { documentId: doc.documentId },
            data: { tenant: tenant.id },
          });
        } catch (_) {}
      }
      created++;

      if (cardUploaded && doc?.documentId) {
        await linkMedia(app, EDITION_UID, doc.documentId, cardUploaded, 'cardImage');
      }
    } catch (e) {
      console.warn('Failed edition:', edition.slug, e.message);
      skipped++;
    }
  }

  console.log('');
  console.log('Kalpana page: 1');
  console.log('Editions created/updated:', created);
  console.log('Skipped:', skipped);

  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  if (app) app.destroy().catch(() => {});
  process.exit(1);
});
