'use strict';

/**
 * Import Directory – Training from mosc-temp (Next.js pages + public images).
 *
 * Sources:
 *   - training/page.tsx hub for title, excerpt, image, order
 *   - training/<slug>/page.tsx for body and contact fields
 *   - public/images/training/*
 *
 *   npm run import:training -- --tenant-id=tenant_demo_002 --replace
 */

try {
  require('dotenv').config();
} catch (_) {}

const fs = require('fs');
const path = require('path');
const mime = require('mime-types');

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
const TRAINING_PAGES = path.join(MOSC_ROOT, 'src', 'app', 'mosc-redesign', '(syro)', 'training');
const PUBLIC_TRAINING_IMAGES = path.join(MOSC_ROOT, 'public', 'images', 'training');

const UID = 'api::training-program.training-program';

const PROGRAM_SLUGS = [
  'sruti-school-of-liturgical-music',
  'divyabodhanam',
  'st-basil-bible-school',
];

function unescapeJsString(s) {
  if (!s) return '';
  return s.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, '\n').trim();
}

function findFileCaseInsensitive(dir, baseName) {
  if (!dir || !baseName || !fs.existsSync(dir)) return null;
  try {
    const target = baseName.toLowerCase();
    for (const name of fs.readdirSync(dir)) {
      if (name.toLowerCase() === target) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isFile()) return full;
      }
    }
  } catch (_) {}
  return null;
}

function loadHubMeta() {
  const hubPath = path.join(TRAINING_PAGES, 'page.tsx');
  if (!fs.existsSync(hubPath)) return new Map();
  const raw = fs.readFileSync(hubPath, 'utf8');
  const map = new Map();
  let order = 0;

  const objRe = /\{\s*id:\s*'([^']+)',\s*title:\s*'((?:\\'|[^'])*)',\s*description:\s*'((?:\\'|[^'])*)',\s*image:\s*'([^']*)',\s*link:\s*'([^']*)'\s*,?\s*\}/g;
  let m;
  while ((m = objRe.exec(raw)) !== null) {
    const link = m[5];
    const slugMatch = link.match(/\/training\/([^/?#]+)/);
    const slug = slugMatch?.[1];
    if (!slug) continue;
    map.set(slug, {
      title: unescapeJsString(m[2]),
      excerpt: unescapeJsString(m[3]),
      cardImage: m[4],
      order: order++,
    });
  }
  return map;
}

function jsxInlineToHtml(content) {
  let html = content
    .replace(/\{' '\}/g, ' ')
    .replace(/\{`([^`]*)`\}/g, '$1')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lsquo;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/<br\s*\/?>/gi, '<br/>');
  html = html.replace(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, '<a href="$1">$2</a>');
  html = html.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/g, '<strong>$1</strong>');
  html = html.replace(/<(?!\/strong>|strong |\/a>|a |br\b)[^>]+>/gi, '');
  return html.replace(/\s+/g, ' ').trim();
}

function parseProseBlocks(section) {
  const parts = [];
  const blockRe = /<(h2|h3|p)(?:\s+className="[^"]*")?[^>]*>([\s\S]*?)<\/\1>/gi;
  let bm;
  while ((bm = blockRe.exec(section)) !== null) {
    const tag = bm[1].toLowerCase();
    const inner = bm[2];
    if (tag === 'h2' || tag === 'h3') {
      const text = jsxInlineToHtml(inner);
      if (text) parts.push(`<${tag}>${text}</${tag}>`);
    } else {
      const text = jsxInlineToHtml(inner);
      if (text.length >= 10 && text !== ' ') parts.push(`<p>${text}</p>`);
    }
  }
  return parts;
}

function parseObjectives(raw) {
  const idx = raw.indexOf('const objectives = [');
  if (idx < 0) return null;
  const openIdx = raw.indexOf('[', idx);
  let depth = 0;
  let endIdx = -1;
  for (let i = openIdx; i < raw.length; i++) {
    if (raw[i] === '[') depth++;
    else if (raw[i] === ']') {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx < 0) return null;
  const inner = raw.slice(openIdx + 1, endIdx);
  const items = [];
  const itemRe = /'((?:\\'|[^'])*)'/g;
  let im;
  while ((im = itemRe.exec(inner)) !== null) {
    const val = unescapeJsString(im[1]);
    if (val) items.push(val);
  }
  if (!items.length) return null;
  const lis = items.map((item) => `<li>${item}</li>`).join('\n');
  return `<h2>Aims &amp; Objectives</h2>\n<ol>\n${lis}\n</ol>`;
}

function extractContactFields(raw) {
  const contactIdx = raw.search(/Contact Address/);
  if (contactIdx < 0) return { address: null, email: null, phones: null, website: null };

  const contactSection = raw.slice(contactIdx, contactIdx + 5000);
  const emails = [];
  const mailRe = /mailto:([^"'\s>]+)/gi;
  let em;
  while ((em = mailRe.exec(contactSection)) !== null) {
    if (!emails.includes(em[1])) emails.push(em[1]);
  }

  let website = null;
  const hrefRe = /href="(https?:\/\/[^"]+)"/gi;
  let hm;
  while ((hm = hrefRe.exec(contactSection)) !== null) {
    if (!hm[1].includes('mailto:')) {
      website = hm[1];
      break;
    }
  }

  const phones = [];
  const phonePatterns = [
    /Ph\.?:?\s*([0-9\s\-()]+)/gi,
    /Phone No\s*:?\s*([0-9\s\-()]+)/gi,
    /Mobile No\s*:?\s*([0-9\s\-()]+)/gi,
    /Mob No\s*:?\s*([0-9\s\-()]+)/gi,
  ];
  for (const re of phonePatterns) {
    let pm;
    while ((pm = re.exec(contactSection)) !== null) {
      const val = pm[1].replace(/\s+/g, ' ').trim();
      if (val && !phones.includes(val)) phones.push(val);
    }
  }

  let address = null;
  const addrBlockMatch = contactSection.match(
    /Contact Address[\s\S]*?<\/h2>\s*<div[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/
  );
  if (addrBlockMatch) {
    const block = addrBlockMatch[1];
    const lines = [];
    const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let pm;
    while ((pm = pRe.exec(block)) !== null) {
      const line = pm[1]
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (line && !line.match(/^(Ph|Phone|Email|Website|Mob)/i)) lines.push(line);
    }
    if (lines.length) address = lines.join('\n');
  }

  if (!address) {
    const plain = contactSection
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '\n')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const addrLines = plain.filter(
      (l) =>
        !l.match(/^(Contact Address|Ph|Phone|Email|Website|Mob|Postal Address)/i) &&
        !l.includes('@') &&
        !l.startsWith('http')
    );
    if (addrLines.length) address = addrLines.slice(0, 8).join('\n');
  }

  return {
    address,
    email: emails.length ? emails.join(', ') : null,
    phones: phones.length ? phones.join('; ') : null,
    website,
  };
}

function parseDetailPage(slug) {
  const pagePath = path.join(TRAINING_PAGES, slug, 'page.tsx');
  if (!fs.existsSync(pagePath)) return null;
  const raw = fs.readFileSync(pagePath, 'utf8');

  const bannerMatch = raw.match(/SyroPageBanner title="([^"]+)"/);
  const imageMatch = raw.match(/<Image[^>]+src="([^"]+)"/);

  const contactIdx = raw.search(/Contact Address/);
  const sidebarIdx = raw.indexOf('TrainingSidebar');
  const mainEnd = contactIdx >= 0 ? contactIdx : sidebarIdx;
  const mainSection = raw.slice(0, mainEnd > 0 ? mainEnd : raw.length);

  const parts = [];

  const introIdx = mainSection.indexOf('space-y-6 font-syro-primary');
  if (introIdx >= 0) {
    parts.push(...parseProseBlocks(mainSection.slice(introIdx)));
  }

  const objectivesHtml = parseObjectives(raw);
  if (objectivesHtml) parts.push(objectivesHtml);

  const syriacIdx = raw.indexOf('Syriac Music');
  if (syriacIdx >= 0) {
    const syriacEnd = contactIdx >= 0 ? contactIdx : sidebarIdx;
    const syriacSection = raw.slice(syriacIdx, syriacEnd > syriacIdx ? syriacEnd : raw.length);
    const syriacParts = parseProseBlocks(syriacSection);
    if (syriacParts.length) {
      parts.push('<h2>Syriac Music</h2>');
      parts.push(...syriacParts.filter((p) => !p.startsWith('<h2>')));
    }
  }

  const bodyHtml = parts.length ? parts.join('\n') : null;
  const contact = extractContactFields(raw);

  const firstParagraphMatch = bodyHtml?.match(/<p>([\s\S]*?)<\/p>/);
  const firstParagraph = firstParagraphMatch
    ? firstParagraphMatch[1].replace(/<[^>]+>/g, ' ').trim()
    : null;

  return {
    bannerTitle: bannerMatch?.[1]?.trim() || null,
    detailImage: imageMatch?.[1] || null,
    bodyHtml,
    firstParagraph,
    ...contact,
  };
}

function resolveImageFile(imageRef) {
  if (!imageRef || typeof imageRef !== 'string') return null;
  const ref = imageRef.trim();
  const candidates = [];

  if (ref.startsWith('/images/training/')) {
    const base = path.basename(ref);
    candidates.push(path.join(PUBLIC_TRAINING_IMAGES, base));
    candidates.push(findFileCaseInsensitive(PUBLIC_TRAINING_IMAGES, base));
  }
  if (ref.startsWith('/images/')) {
    candidates.push(path.join(MOSC_ROOT, 'public', ref.replace(/^\//, '').replace(/\//g, path.sep)));
    const base = path.basename(ref);
    candidates.push(findFileCaseInsensitive(PUBLIC_TRAINING_IMAGES, base));
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

async function deleteTenantPrograms(strapi, tenant) {
  const existing = await strapi.documents(UID).findMany({
    filters: { tenant: tenant.id },
    limit: 500,
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

let app;

async function main() {
  console.log('Training programs import from mosc-temp');
  console.log('  MOSC_ROOT:', MOSC_ROOT);
  console.log('  TENANT_ID:', TENANT_ID);
  if (DRY_RUN) console.log('  DRY_RUN=1');
  if (REPLACE) console.log('  --replace: delete tenant rows then import fresh');
  console.log('');

  if (!fs.existsSync(MOSC_ROOT)) {
    console.error('MOSC_TEMP_DIR not found:', MOSC_ROOT);
    process.exit(1);
  }

  const hubMeta = loadHubMeta();
  console.log('Hub programs (page.tsx):', hubMeta.size);
  console.log('Detail slugs:', PROGRAM_SLUGS.length);
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
    const deleted = await deleteTenantPrograms(app, tenant);
    console.log('Deleted existing training programs for tenant:', deleted);
  } else if (REPLACE && DRY_RUN) {
    const existing = await app.documents(UID).findMany({ filters: { tenant: tenant.id }, limit: 500 });
    const list = existing?.results ?? existing?.data ?? (Array.isArray(existing) ? existing : []);
    console.log('Would delete', list.length, 'existing training programs for tenant');
  }

  const existing = await app.documents(UID).findMany({
    filters: { tenant: tenant.id },
    limit: 500,
  });
  const existingList = existing?.results ?? existing?.data ?? (Array.isArray(existing) ? existing : []);
  const bySlug = new Map();
  for (const row of existingList) {
    if (row.slug) bySlug.set(row.slug, row);
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let orphanOrder = hubMeta.size;

  for (const slug of PROGRAM_SLUGS) {
    const hub = hubMeta.get(slug) || {};
    const detail = parseDetailPage(slug);
    if (!detail) {
      console.warn('Skip (no detail page):', slug);
      skipped++;
      continue;
    }

    const name = hub.title || detail.bannerTitle || slug;
    const excerpt = hub.excerpt || (detail.firstParagraph ? detail.firstParagraph.slice(0, 280) : null);
    const order = hub.order != null ? hub.order : orphanOrder++;

    const imageCandidates = [hub.cardImage, detail.detailImage];
    let imageFile = null;
    for (const ref of imageCandidates) {
      if (!ref) continue;
      imageFile = resolveImageFile(ref);
      if (imageFile) break;
    }

    const prev = bySlug.get(slug);
    if (prev && !REPLACE) {
      console.log('Skip (exists):', slug);
      skipped++;
      continue;
    }

    const data = {
      name,
      slug,
      excerpt,
      body: detail.bodyHtml || null,
      address: detail.address,
      email: detail.email,
      phones: detail.phones,
      website: detail.website,
      order,
      tenant: tenant.id,
    };

    if (DRY_RUN) {
      console.log('Would import:', slug, '|', name.slice(0, 50), '| image:', imageFile ? path.basename(imageFile) : 'none');
      created++;
      continue;
    }

    try {
      let doc;
      if (prev && REPLACE) {
        doc = await app.documents(UID).update({ documentId: prev.documentId, data });
        updated++;
        console.log('Updated:', slug);
      } else {
        doc = await app.documents(UID).create({ data });
        created++;
        console.log('Created:', slug);
        try {
          await app.db.query(UID).update({
            where: { documentId: doc.documentId },
            data: { tenant: tenant.id },
          });
        } catch (_) {}
      }

      const docId = doc?.documentId ?? prev?.documentId;
      if (imageFile && docId) {
        const uploaded = await uploadLocalImage(app, imageFile);
        if (uploaded?.documentId) {
          try {
            await app.documents(UID).update({
              documentId: docId,
              data: { image: { connect: [{ documentId: uploaded.documentId }] } },
            });
          } catch (_) {}
          await setMediaRelationViaDb(app, docId, uploaded.documentId);
        }
      }
    } catch (e) {
      console.warn('Failed:', slug, e.message);
      skipped++;
    }
  }

  console.log('');
  console.log(DRY_RUN ? 'Would create' : 'Created', created);
  console.log(DRY_RUN ? 'Would update' : 'Updated', updated);
  console.log('Skipped', skipped);

  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  if (app) app.destroy().catch(() => {});
  process.exit(1);
});
