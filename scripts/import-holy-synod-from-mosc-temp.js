'use strict';

/**
 * Import Holy Synod members from mosc-temp (HTML clone + Next.js pages + public images).
 * Creates entries in Directory – Holy Synod only; does not modify other collection types.
 *
 * Sources:
 *   - Next.js mosc-redesign holy-synod/<slug>/page.tsx (preferred body + contact)
 *   - code_clone_ref/mosc_in/holysynod HTML pages (fallback)
 *   - Hub page.tsx for excerpt / order / card title
 *
 * Env:
 *   MOSC_TEMP_DIR     (default: C:\project_workspace\mosc-temp)
 *   TENANT_ID         (default: tenant_demo_002)
 *   DRY_RUN=1         Preview only
 *   --replace         Update existing rows for same slug+tenant
 *   --images-only     Replace image media only (no text/content changes)
 *   --keep-images     On create/replace, never upload/replace images (default with --replace)
 *
 *   npm run import:holy-synod -- --replace --keep-images
 *   npm run import:holy-synod -- --tenant-id=mosc_malankara_orthodox_2 --replace --keep-images
 */

try {
  require('dotenv').config();
} catch (_) {}

const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const cheerio = require('cheerio');

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const REPLACE = process.argv.includes('--replace');
const IMAGES_ONLY = process.argv.includes('--images-only');
const KEEP_IMAGES =
  process.argv.includes('--keep-images') || (REPLACE && !IMAGES_ONLY && !process.argv.includes('--force-images'));
const TENANT_ID = (() => {
  const m = process.argv.find((a) => a.startsWith('--tenant-id='));
  if (m) return m.split('=')[1].trim();
  return process.env.TENANT_ID || 'tenant_demo_002';
})();

function effectiveSlug(baseSlug, tenantId) {
  if (tenantId === 'mosc_malankara_orthodox_2') {
    if (baseSlug.endsWith('-mo2')) return baseSlug;
    return `${baseSlug}-mo2`;
  }
  return baseSlug.replace(/-mo2$/, '');
}

function decodeJsxText(s) {
  return String(s || '')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse mosc-redesign holy-synod/<slug>/page.tsx for biography + contact.
 */
function parseDetailTsx(slug) {
  const pagePath = path.join(HOLYSYNOD_PAGES, slug, 'page.tsx');
  if (!fs.existsSync(pagePath)) return null;
  const raw = fs.readFileSync(pagePath, 'utf8');

  const titleMatch =
    raw.match(/title:\s*'((?:\\'|[^'])*)'/) ||
    raw.match(/title:\s*"((?:\\"|[^"])*)"/) ||
    raw.match(/SyroPageBanner[\s\S]*?title="([^"]+)"/) ||
    raw.match(/SyroPageBanner[\s\S]*?title=\{\s*'((?:\\'|[^'])*)'\s*\}/);
  const name = titleMatch ? decodeJsxText(titleMatch[1]) : null;

  const contactSplit = raw.search(/>\s*Contact\s*</i);
  const bioRaw = contactSplit >= 0 ? raw.slice(0, contactSplit) : raw;
  const contactRaw = contactSplit >= 0 ? raw.slice(contactSplit) : '';

  function extractParagraphs(chunk) {
    const matches = [...chunk.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)];
    const out = [];
    for (const m of matches) {
      let inner = m[1]
        .replace(/<a[^>]*href="mailto:([^"]+)"[^>]*>[\s\S]*?<\/a>/gi, '$1')
        .replace(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>[\s\S]*?<\/a>/gi, '$1')
        .replace(/\{'\s*'\}/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&');
      inner = decodeJsxText(inner);
      if (!inner || inner.length < 2) continue;
      if (/^(contact|facebook|instagram)\s*:?$/i.test(inner)) continue;
      out.push(inner);
    }
    return out;
  }

  const bioParas = extractParagraphs(bioRaw).filter((p) => {
    // Drop page chrome / duplicate titles that match the banner name exactly
    if (name && p === name) return false;
    return true;
  });
  const contactParas = extractParagraphs(contactRaw);

  let email = null;
  let phones = null;
  const addressParts = [];

  for (const p of contactParas) {
    const mail = p.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (/^email\s*:/i.test(p) || mail) {
      if (mail) email = mail[0];
      continue;
    }
    if (/^(facebook|instagram)\s*:/i.test(p) || /facebook\.com|instagram\.com/i.test(p)) continue;
    if (/^(mob|ph|tel|cell|phone)\s*:/i.test(p) || /\b(?:mob|ph|tel|cell)\s*:/i.test(p)) {
      const labeled = [...p.matchAll(/(?:mob|ph|tel|cell|phone)\s*:\s*([+\d][\d\s,\-\/]*)/gi)];
      const nums = labeled.map((x) => x[1].trim()).filter(Boolean);
      if (nums.length) phones = phones ? `${phones}, ${nums.join(', ')}` : nums.join(', ');
      else phones = phones ? `${phones}, ${p}` : p;
      continue;
    }
    addressParts.push(p);
  }

  // Fallback: contact mixed into bio when no Contact heading
  if (!contactParas.length) {
    const keptBio = [];
    for (const p of bioParas) {
      const mail = p.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      if (/^email\s*:/i.test(p) || mail) {
        if (mail) email = mail[0];
        continue;
      }
      if (/^(mob|ph|tel|cell)\s*:/i.test(p)) {
        const labeled = [...p.matchAll(/(?:mob|ph|tel|cell|phone)\s*:\s*([+\d][\d\s,\-\/]*)/gi)];
        const nums = labeled.map((x) => x[1].trim()).filter(Boolean);
        if (nums.length) phones = phones ? `${phones}, ${nums.join(', ')}` : nums.join(', ');
        continue;
      }
      keptBio.push(p);
    }
    bioParas.length = 0;
    bioParas.push(...keptBio);
  }

  const bodyHtml = bioParas.map((p) => `<p>${p}</p>`).join('\n');
  return {
    name,
    address: addressParts.length ? addressParts.join('\n') : null,
    email,
    phones,
    bodyHtml: bodyHtml || null,
    source: 'tsx',
  };
}

const MOSC_ROOT = path.resolve(
  process.env.MOSC_TEMP_DIR || process.env.STRAPI_DATA_IMPORT_MOSC_TEMP_DIR || 'C:\\project_workspace\\mosc-temp'
);
const HOLYSYNOD_HTML = path.join(MOSC_ROOT, 'code_clone_ref', 'mosc_in', 'holysynod');
const HOLYSYNOD_PAGES = path.join(MOSC_ROOT, 'src', 'app', 'mosc-redesign', '(syro)', 'holy-synod');
const PUBLIC_HOLYSYNOD_IMAGES = path.join(MOSC_ROOT, 'public', 'images', 'holy-synod');
const MOSC_ASSETS_HOLYSYNOD = path.join(MOSC_ROOT, 'public', 'mosc', 'assets', 'images', 'mosc_images', 'Holy Synod');

const UID = 'api::holy-synod-member.holy-synod-member';

function slugify(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function text($el) {
  return $el.text().trim().replace(/\s+/g, ' ');
}

function loadHubMeta() {
  const hubPath = path.join(HOLYSYNOD_PAGES, 'page.tsx');
  if (!fs.existsSync(hubPath)) return new Map();
  const raw = fs.readFileSync(hubPath, 'utf8');
  const imageBaseMatch = raw.match(/const IMAGE_BASE = '([^']+)'/);
  const imageBase = imageBaseMatch ? imageBaseMatch[1] : '/mosc/assets/images/mosc_images/Holy Synod';

  const map = new Map();
  const blockRe =
    /title:\s*'((?:\\'|[^'])*)'[\s\S]*?excerpt:\s*\n\s*'((?:\\'|[^'])*)'[\s\S]*?image:\s*(?:'([^']*)'|`([^`]*?)`)[\s\S]*?internalHref:\s*'([^']*)'/g;
  let m;
  let order = 0;
  while ((m = blockRe.exec(raw)) !== null) {
    const internalHref = m[5];
    const slug = internalHref.split('/').filter(Boolean).pop();
    if (!slug) continue;
    let cardImage = (m[3] || m[4] || '').trim();
    cardImage = cardImage.replace(/\$\{IMAGE_BASE\}/g, imageBase);
    map.set(slug, {
      title: m[1].replace(/\\'/g, "'").trim(),
      excerpt: m[2].replace(/\\'/g, "'").trim(),
      cardImage,
      order: order++,
    });
  }
  return map;
}

function loadPageDetailImage(slug) {
  const pagePath = path.join(HOLYSYNOD_PAGES, slug, 'page.tsx');
  if (!fs.existsSync(pagePath)) return null;
  const raw = fs.readFileSync(pagePath, 'utf8');
  const m = raw.match(/<Image[^>]+src="([^"]+)"/) || raw.match(/src="(\/images\/holy-synod\/[^"]+)"/);
  return m ? m[1] : null;
}

function parseDetailHtml(html, htmlFile) {
  const $ = cheerio.load(html);
  const box = $('.cnt-box-inner');
  if (!box.length) return null;

  const name = text(box.find('h3').first());
  if (!name) return null;

  const imgSrc = box.find('img.wp-post-image').first().attr('src') || box.find('img').first().attr('src');
  const paragraphs = box
    .find('p')
    .map((_, el) => text($(el)))
    .get()
    .filter(Boolean);

  let address = null;
  let email = null;
  let phones = null;
  const bioParts = [];

  for (const p of paragraphs) {
    const lower = p.toLowerCase();
    if (/^email\s*:/i.test(p) || lower.includes('email:')) {
      const mail = p.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      if (mail) email = mail[0];
      continue;
    }
    if (/^address\s*:/i.test(p) || /\bph\s*:/i.test(p) || /\bcell\s*:/i.test(p) || /\btel\s*:/i.test(p)) {
      address = address ? `${address}\n${p}` : p;
      const phoneMatches = p.match(/(?:ph|cell|tel)\s*:\s*([^]+)/gi);
      if (phoneMatches) {
        const nums = phoneMatches.map((x) => x.replace(/^(ph|cell|tel)\s*:\s*/i, '').trim());
        phones = phones ? `${phones}, ${nums.join(', ')}` : nums.join(', ');
      }
      continue;
    }
    bioParts.push(p);
  }

  const bodyHtml = bioParts.map((p) => `<p>${p}</p>`).join('\n');
  const htmlDir = path.dirname(htmlFile);

  return {
    name,
    htmlImagePath: imgSrc,
    htmlDir,
    address,
    email,
    phones,
    bodyHtml,
  };
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

function resolveImageFile(imageRef, htmlDir) {
  if (!imageRef || typeof imageRef !== 'string') return null;
  const ref = imageRef.trim();
  const candidates = [];

  if (ref.startsWith('/images/holy-synod/')) {
    const base = path.basename(ref);
    candidates.push(path.join(PUBLIC_HOLYSYNOD_IMAGES, base));
    candidates.push(findFileCaseInsensitive(PUBLIC_HOLYSYNOD_IMAGES, base));
  }
  if (ref.startsWith('/mosc/assets/')) {
    candidates.push(path.join(MOSC_ROOT, 'public', ref.replace(/^\//, '').replace(/\//g, path.sep)));
    const base = path.basename(ref);
    candidates.push(findFileCaseInsensitive(MOSC_ASSETS_HOLYSYNOD, base));
  }
  if (ref.includes('Holy Synod') || ref.includes('mosc_images')) {
    candidates.push(path.join(MOSC_ROOT, 'public', ref.replace(/^\//, '').replace(/\//g, path.sep)));
    candidates.push(path.join(MOSC_ASSETS_HOLYSYNOD, path.basename(ref)));
    candidates.push(findFileCaseInsensitive(MOSC_ASSETS_HOLYSYNOD, path.basename(ref)));
  }
  if (ref.startsWith('../../')) {
    candidates.push(path.resolve(htmlDir, ref));
  } else if (!ref.startsWith('http')) {
    candidates.push(path.resolve(htmlDir, ref));
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

function discoverHtmlPages() {
  const pages = [];
  if (!fs.existsSync(HOLYSYNOD_HTML)) return pages;

  const rootHtml = path.join(HOLYSYNOD_HTML, 'his-holiness-baselios-marthoma-mathews-iii.html');
  if (fs.existsSync(rootHtml)) {
    pages.push({ slug: 'his-holiness-baselios-marthoma-mathews-iii', htmlPath: rootHtml });
  }

  const entries = fs.readdirSync(HOLYSYNOD_HTML, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const indexHtml = path.join(HOLYSYNOD_HTML, ent.name, 'index.html');
    if (fs.existsSync(indexHtml)) {
      pages.push({ slug: ent.name, htmlPath: indexHtml });
    }
  }
  return pages;
}

function discoverMemberSlugs(hubMeta) {
  const slugs = new Set([...hubMeta.keys()]);
  if (fs.existsSync(HOLYSYNOD_PAGES)) {
    for (const ent of fs.readdirSync(HOLYSYNOD_PAGES, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (fs.existsSync(path.join(HOLYSYNOD_PAGES, ent.name, 'page.tsx'))) {
        slugs.add(ent.name);
      }
    }
  }
  for (const { slug } of discoverHtmlPages()) slugs.add(slug);
  return [...slugs];
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
  console.log('Holy Synod import from mosc-temp');
  console.log('  MOSC_ROOT:', MOSC_ROOT);
  console.log('  TENANT_ID:', TENANT_ID);
  if (DRY_RUN) console.log('  DRY_RUN=1');
  if (REPLACE) console.log('  --replace: update existing slugs');
  if (IMAGES_ONLY) console.log('  --images-only: replace images only (no content changes)');
  if (KEEP_IMAGES) console.log('  --keep-images: leave existing images untouched');
  console.log('');

  if (!fs.existsSync(MOSC_ROOT)) {
    console.error('MOSC_TEMP_DIR not found:', MOSC_ROOT);
    process.exit(1);
  }

  const hubMeta = loadHubMeta();
  const htmlBySlug = new Map(discoverHtmlPages().map((p) => [p.slug, p.htmlPath]));
  const memberSlugs = discoverMemberSlugs(hubMeta);
  console.log('Hub members (page.tsx):', hubMeta.size);
  console.log('Member slugs to process:', memberSlugs.length);
  console.log('');

  // Use a NODE_ENV without config/env/*/plugins.js S3 override so local disk upload works.
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
    filters: {
      $or: [{ tenant: tenant.id }, { tenant: { documentId: tenant.documentId } }],
    },
    populate: { image: true },
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

  for (const baseSlug of memberSlugs) {
    const slug = effectiveSlug(baseSlug, TENANT_ID);
    const tsx = parseDetailTsx(baseSlug);
    const htmlPath = htmlBySlug.get(baseSlug);
    let htmlParsed = null;
    if (htmlPath && fs.existsSync(htmlPath)) {
      htmlParsed = parseDetailHtml(fs.readFileSync(htmlPath, 'utf8'), htmlPath);
    }

    if (!tsx && !htmlParsed) {
      console.warn('Skip (parse failed):', baseSlug);
      skipped++;
      continue;
    }

    const hub = hubMeta.get(baseSlug) || {};
    const name = hub.title || tsx?.name || htmlParsed?.name;
    if (!name) {
      console.warn('Skip (no name):', baseSlug);
      skipped++;
      continue;
    }

    const body =
      (tsx?.bodyHtml && tsx.bodyHtml.length >= 80 ? tsx.bodyHtml : null) ||
      htmlParsed?.bodyHtml ||
      tsx?.bodyHtml ||
      null;
    const excerpt =
      hub.excerpt ||
      (body ? body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 280) : null);
    const address = tsx?.address || htmlParsed?.address || null;
    const email = tsx?.email || htmlParsed?.email || null;
    const phones = tsx?.phones || htmlParsed?.phones || null;
    const memberType =
      baseSlug.includes('his-holiness') || /catholicos/i.test(name) ? 'catholicos' : 'metropolitan';
    const order = hub.order != null ? hub.order : 0;

    const imageCandidates = [hub.cardImage, loadPageDetailImage(baseSlug)];
    let imageFile = null;
    let imageRefUsed = null;
    for (const ref of imageCandidates) {
      if (!ref) continue;
      imageFile = resolveImageFile(ref, htmlParsed?.htmlDir || HOLYSYNOD_PAGES);
      if (imageFile) {
        imageRefUsed = ref;
        break;
      }
    }

    const prev = bySlug.get(slug) || bySlug.get(baseSlug);
    if (IMAGES_ONLY) {
      if (!prev) {
        console.warn('Skip (no row for images-only):', slug);
        skipped++;
        continue;
      }
      if (DRY_RUN) {
        console.log('Would replace image:', slug, '|', imageFile ? path.basename(imageFile) : 'none');
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
      slug,
      memberType,
      excerpt,
      body,
      address,
      email,
      phones,
      order,
      tenant: connectTenant,
    };

    if (prev && !REPLACE) {
      console.log('Skip (exists):', slug);
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(
        'Would import:',
        slug,
        '| body:',
        body ? body.length : 0,
        '| addr:',
        address ? 'yes' : 'no',
        '| email:',
        email || '-',
        '| keepImg:',
        Boolean(KEEP_IMAGES && prev?.image)
      );
      if (prev) updated++;
      else created++;
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
        console.log(
          'Updated:',
          slug,
          `| body=${body ? body.length : 0}`,
          email ? `| ${email}` : '',
          tsx ? '(tsx)' : '(html)'
        );
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
      const alreadyHasImage = Boolean(prev?.image);
      if (imageFile && docId && !(KEEP_IMAGES && alreadyHasImage)) {
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
