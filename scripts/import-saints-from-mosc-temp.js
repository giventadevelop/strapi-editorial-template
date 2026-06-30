'use strict';

/**
 * Import Saints entries from mosc-temp (Next.js pages + public images).
 * Creates entries in Directory – Saints only; does not modify other collection types.
 *
 * Sources:
 *   - saints/page.tsx hub (SAINTS_CARDS) for title, excerpt, card image, order
 *   - saints/<slug>/page.tsx for body and detail featured image
 *   - public/images/saints/*
 *
 * Env:
 *   MOSC_TEMP_DIR     (default: C:\project_workspace\mosc-temp)
 *   TENANT_ID         (default: tenant_demo_002)
 *   DRY_RUN=1         Preview only
 *   --replace         Update existing rows for same slug+tenant
 *   --images-only     Replace image media only (no text/content changes)
 *   --slug-suffix=-mo2  Append to slug when tenant shares instance (e.g. mosc_malankara_orthodox_2)
 *
 * Image priority (matches mosc-redesign saints hub cards):
 *   1. Hub card image from saints/page.tsx
 *   2. Detail page featured image from saints/<slug>/page.tsx
 *
 *   node scripts/import-saints-from-mosc-temp.js
 *   node scripts/import-saints-from-mosc-temp.js --tenant-id=tenant_demo_002 --replace
 */

try {
  require('dotenv').config();
} catch (_) {}

const fs = require('fs');
const path = require('path');
const mime = require('mime-types');

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const REPLACE = process.argv.includes('--replace');
const IMAGES_ONLY = process.argv.includes('--images-only');
const TENANT_ID = (() => {
  const m = process.argv.find((a) => a.startsWith('--tenant-id='));
  if (m) return m.split('=')[1].trim();
  return process.env.TENANT_ID || 'tenant_demo_002';
})();
const SLUG_SUFFIX = (() => {
  const m = process.argv.find((a) => a.startsWith('--slug-suffix='));
  if (m) return m.split('=').slice(1).join('=');
  if (TENANT_ID === 'mosc_malankara_orthodox_2') return '-mo2';
  return '';
})();

const MOSC_ROOT = path.resolve(
  process.env.MOSC_TEMP_DIR || process.env.STRAPI_DATA_IMPORT_MOSC_TEMP_DIR || 'C:\\project_workspace\\mosc-temp'
);
const SAINTS_PAGES = path.join(MOSC_ROOT, 'src', 'app', 'mosc-redesign', '(syro)', 'saints');
const HOMEPAGE_PATH = path.join(MOSC_ROOT, 'src', 'app', 'mosc-redesign', 'page.tsx');
const PUBLIC_SAINTS_IMAGES = path.join(MOSC_ROOT, 'public', 'images', 'saints');
const PUBLIC_MOSC_IMAGES = path.join(MOSC_ROOT, 'public', 'mosc', 'assets', 'images', 'mosc_images');

const UID = 'api::saint-entry.saint-entry';

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

function effectiveSlug(baseSlug) {
  return `${baseSlug}${SLUG_SUFFIX}`;
}

function loadHubMeta() {
  const hubPath = path.join(SAINTS_PAGES, 'page.tsx');
  if (!fs.existsSync(hubPath)) return new Map();
  const raw = fs.readFileSync(hubPath, 'utf8');
  const map = new Map();
  let order = 0;

  const cardPatterns = [
    /\{\s*title:\s*'((?:\\'|[^'])*)',\s*excerpt:\s*'((?:\\'|[^'])*)',\s*href:\s*'([^']*)',\s*image:\s*'([^']*)',?\s*\}/g,
    /\{\s*title:\s*'((?:\\'|[^'])*)',\s*excerpt:\s*"((?:\\"|[^"])*)",\s*href:\s*'([^']*)',\s*image:\s*'([^']*)',?\s*\}/g,
  ];
  for (const cardRe of cardPatterns) {
    let m;
    while ((m = cardRe.exec(raw)) !== null) {
      const slug = m[3].split('/').filter(Boolean).pop();
      if (!slug || map.has(slug)) continue;
      map.set(slug, {
        title: m[1].replace(/\\'/g, "'").trim(),
        excerpt: m[2].replace(/\\'/g, "'").replace(/\\"/g, '"').trim(),
        cardImage: m[4],
        order: order++,
      });
    }
  }
  return map;
}

/** Homepage carousel (Our Saints & Blesseds) from mosc-redesign/page.tsx */
function loadCarouselMeta() {
  if (!fs.existsSync(HOMEPAGE_PATH)) return new Map();
  const raw = fs.readFileSync(HOMEPAGE_PATH, 'utf8');
  const saintsBlock = raw.match(/const saints:\s*Saint\[\]\s*=\s*\[([\s\S]*?)\];/);
  if (!saintsBlock) return new Map();
  const map = new Map();
  let order = 0;
  const entryRe =
    /\{\s*name:\s*"((?:\\"|[^"])*)",\s*href:\s*"([^"]+)",\s*image:\s*"([^"]+)"(?:,\s*alt:\s*"((?:\\"|[^"])*)")?/g;
  let m;
  while ((m = entryRe.exec(saintsBlock[1])) !== null) {
    const slug = m[2].split('/').filter(Boolean).pop();
    if (!slug) continue;
    map.set(slug, {
      name: m[1].replace(/\\"/g, '"').trim(),
      href: m[2],
      image: m[3],
      alt: m[4] ? m[4].replace(/\\"/g, '"').trim() : null,
      carouselOrder: order++,
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
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/<br\s*\/?>/gi, '<br/>');
  html = html.replace(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, '<a href="$1">$2</a>');
  html = html.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/g, '<strong>$1</strong>');
  html = html.replace(/<(?!\/strong>|strong |\/a>|a |br\b)[^>]+>/gi, '');
  return html.replace(/\s+/g, ' ').trim();
}

function parseProseSection(section) {
  const parts = [];
  const blockRe = /<(h2|h3|p|ul)(?:\s+className="[^"]*")?[^>]*>([\s\S]*?)<\/\1>/gi;
  let bm;
  while ((bm = blockRe.exec(section)) !== null) {
    const tag = bm[1].toLowerCase();
    const inner = bm[2];
    if (tag === 'ul') {
      const items = [];
      const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let li;
      while ((li = liRe.exec(inner)) !== null) {
        const text = jsxInlineToHtml(li[1]);
        if (text && text !== ' ') items.push(`<li>${text}</li>`);
      }
      if (items.length) parts.push(`<ul>${items.join('')}</ul>`);
    } else if (tag === 'h2' || tag === 'h3') {
      const text = jsxInlineToHtml(inner);
      if (text) parts.push(`<${tag}>${text}</${tag}>`);
    } else {
      const text = jsxInlineToHtml(inner);
      if (text.length >= 2 && text !== ' ') parts.push(`<p>${text}</p>`);
    }
  }
  return parts.length ? parts.join('\n') : null;
}

function parseDetailPage(slug) {
  const pagePath = path.join(SAINTS_PAGES, slug, 'page.tsx');
  if (!fs.existsSync(pagePath)) return null;
  const raw = fs.readFileSync(pagePath, 'utf8');

  const pageTitleMatch = raw.match(/const PAGE_TITLE = '((?:\\'|[^'])*)'/);
  const bannerLiteral = raw.match(/SyroPageBanner title="([^"]+)"/);
  const bannerTitle = pageTitleMatch
    ? pageTitleMatch[1].replace(/\\'/g, "'").trim()
    : bannerLiteral?.[1]?.trim() || null;

  const imageMatch = raw.match(/<Image[^>]+src="([^"]+)"/);

  const proseIdx = raw.indexOf('className="prose');
  const endMarkers = ['SAINTS_SIDEBAR_LINKS', 'QuickLinks', 'lg:col-span-1'];
  let endIdx = raw.length;
  for (const marker of endMarkers) {
    const i = raw.indexOf(marker, proseIdx >= 0 ? proseIdx : 0);
    if (i > (proseIdx >= 0 ? proseIdx : 0) && i < endIdx) endIdx = i;
  }
  const section = proseIdx >= 0 ? raw.slice(proseIdx, endIdx) : raw;

  const bodyHtml = parseProseSection(section);
  const firstParagraphMatch = bodyHtml?.match(/<p>([\s\S]*?)<\/p>/);
  const firstParagraph = firstParagraphMatch ? firstParagraphMatch[1].replace(/<[^>]+>/g, ' ').trim() : null;

  return {
    bannerTitle,
    detailImage: imageMatch?.[1] || null,
    bodyHtml,
    firstParagraph,
  };
}

function resolveImageFile(imageRef) {
  if (!imageRef || typeof imageRef !== 'string') return null;
  const ref = imageRef.trim();
  const candidates = [];

  if (ref.startsWith('/images/saints/')) {
    const base = path.basename(ref);
    candidates.push(path.join(PUBLIC_SAINTS_IMAGES, base));
    candidates.push(findFileCaseInsensitive(PUBLIC_SAINTS_IMAGES, base));
  }
  if (ref.startsWith('/mosc/assets/images/mosc_images/')) {
    const rel = ref.replace(/^\/mosc\/assets\/images\/mosc_images\//, '').replace(/\//g, path.sep);
    candidates.push(path.join(PUBLIC_MOSC_IMAGES, rel));
    candidates.push(findFileCaseInsensitive(PUBLIC_MOSC_IMAGES, path.basename(rel)));
  }
  if (ref.startsWith('/images/')) {
    candidates.push(path.join(MOSC_ROOT, 'public', ref.replace(/^\//, '').replace(/\//g, path.sep)));
    const base = path.basename(ref);
    candidates.push(findFileCaseInsensitive(PUBLIC_SAINTS_IMAGES, base));
  }

  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch (_) {}
  }
  return null;
}

function discoverDetailSlugs() {
  const slugs = [];
  if (!fs.existsSync(SAINTS_PAGES)) return slugs;
  for (const ent of fs.readdirSync(SAINTS_PAGES, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const pagePath = path.join(SAINTS_PAGES, ent.name, 'page.tsx');
    if (fs.existsSync(pagePath)) slugs.push(ent.name);
  }
  return slugs.sort();
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
    const contentTypeUid = UID;
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
    await db(morphTable).where({ related_id: entityRow.id, related_type: contentTypeUid, field: 'image' }).del();
    await db(morphTable).insert({
      file_id: fileRow.id,
      related_id: entityRow.id,
      related_type: contentTypeUid,
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

async function main() {
  console.log('Saints import from mosc-temp');
  console.log('  MOSC_ROOT:', MOSC_ROOT);
  console.log('  TENANT_ID:', TENANT_ID);
  if (SLUG_SUFFIX) console.log('  SLUG_SUFFIX:', SLUG_SUFFIX);
  if (DRY_RUN) console.log('  DRY_RUN=1');
  if (REPLACE) console.log('  --replace: update existing slugs');
  if (IMAGES_ONLY) console.log('  --images-only: replace images only (no content changes)');
  console.log('');

  if (!fs.existsSync(MOSC_ROOT)) {
    console.error('MOSC_TEMP_DIR not found:', MOSC_ROOT);
    process.exit(1);
  }

  const hubMeta = loadHubMeta();
  const carouselMeta = loadCarouselMeta();
  const slugs = discoverDetailSlugs();
  console.log('Hub cards (page.tsx):', hubMeta.size);
  console.log('Homepage carousel entries:', carouselMeta.size);
  console.log('Detail pages:', slugs.length);
  console.log('');

  const prevNodeEnv = process.env.NODE_ENV;
  if (!process.env.STRAPI_IMPORT_NODE_ENV) {
    process.env.NODE_ENV = 'staging';
  }

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const app = await createStrapi(await compileStrapi()).load();
  if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
  app.log.level = 'error';

  const tenant = await getOrCreateTenant(app, TENANT_ID);
  const connectTenant = tenant.id;

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

  for (const slug of slugs) {
    const hub = hubMeta.get(slug) || {};
    const carousel = carouselMeta.get(slug) || {};
    const detail = parseDetailPage(slug);
    if (!detail) {
      console.warn('Skip (no detail page):', slug);
      skipped++;
      continue;
    }

    const storageSlug = effectiveSlug(slug);
    const name = carousel.name || hub.title || detail.bannerTitle || slug;
    const excerpt = hub.excerpt || (detail.firstParagraph ? detail.firstParagraph.slice(0, 280) : null);
    const order =
      carousel.carouselOrder != null
        ? carousel.carouselOrder
        : hub.order != null
          ? hub.order
          : orphanOrder++;

    const imageCandidates = [carousel.image, hub.cardImage, detail.detailImage];
    let imageFile = null;
    let imageRefUsed = null;
    for (const ref of imageCandidates) {
      if (!ref) continue;
      imageFile = resolveImageFile(ref);
      if (imageFile) {
        imageRefUsed = ref;
        break;
      }
    }

    const prev = bySlug.get(storageSlug);
    if (IMAGES_ONLY) {
      if (!prev) {
        console.warn('Skip (no row for images-only):', storageSlug);
        skipped++;
        continue;
      }
      if (DRY_RUN) {
        console.log(
          'Would replace image:',
          slug,
          '|',
          imageFile ? path.basename(imageFile) : 'none',
          '| ref:',
          imageRefUsed || '-'
        );
        updated++;
        continue;
      }
      if (imageFile && prev.documentId) {
        const uploaded = await uploadLocalImage(app, imageFile);
        if (uploaded?.documentId) {
          try {
            await app.documents(UID).update({
              documentId: prev.documentId,
              data: { image: { connect: [{ documentId: uploaded.documentId }] } },
            });
          } catch (_) {}
          await setMediaRelationViaDb(app, prev.documentId, uploaded.documentId);
          console.log('Image updated:', slug, '←', path.basename(imageFile));
          updated++;
        } else {
          console.warn('Image upload failed:', slug);
          skipped++;
        }
      } else {
        console.warn('Skip (image not found):', slug, imageRefUsed || hub.cardImage || '-');
        skipped++;
      }
      continue;
    }

    const data = {
      name,
      slug: storageSlug,
      excerpt,
      body: detail.bodyHtml || null,
      order,
      tenant: connectTenant,
    };

    if (prev && !REPLACE) {
      console.log('Skip (exists):', storageSlug);
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(
        'Would import:',
        slug,
        '|',
        name.slice(0, 50),
        '| image:',
        imageFile ? path.basename(imageFile) : 'none'
      );
      created++;
      continue;
    }

    try {
      let doc;
      if (prev && REPLACE) {
        doc = await app.documents(UID).update({
          documentId: prev.documentId,
          data,
        });
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
  process.exit(1);
});
