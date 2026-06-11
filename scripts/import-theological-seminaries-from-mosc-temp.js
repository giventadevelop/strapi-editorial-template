'use strict';

/**
 * Import Theological Seminaries from mosc-temp (Next.js pages + public images).
 * Creates entries in Directory – Theological Seminaries only.
 *
 * Sources:
 *   - theological-seminaries/page.tsx hub for title, subtitle, excerpt, image, location, established, order
 *   - theological-seminaries/<slug>/page.tsx for body and contact fields
 *   - public/images/theological/*
 *
 *   node scripts/import-theological-seminaries-from-mosc-temp.js
 *   node scripts/import-theological-seminaries-from-mosc-temp.js --tenant-id=tenant_demo_002 --replace
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

const MOSC_ROOT = path.resolve(
  process.env.MOSC_TEMP_DIR || process.env.STRAPI_DATA_IMPORT_MOSC_TEMP_DIR || 'C:\\project_workspace\\mosc-temp'
);
const SEMINARY_PAGES = path.join(MOSC_ROOT, 'src', 'app', 'mosc-redesign', '(syro)', 'theological-seminaries');
const PUBLIC_THEOLOGICAL_IMAGES = path.join(MOSC_ROOT, 'public', 'images', 'theological');

const UID = 'api::theological-seminary.theological-seminary';

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
  const hubPath = path.join(SEMINARY_PAGES, 'page.tsx');
  if (!fs.existsSync(hubPath)) return new Map();
  const raw = fs.readFileSync(hubPath, 'utf8');
  const map = new Map();
  let order = 0;

  const blockRe =
    /\{\s*slug:\s*'([^']+)',\s*title:\s*'((?:\\'|[^'])*)',\s*subtitle:\s*'((?:\\'|[^'])*)',\s*description:\s*'((?:\\'|[^'])*)',\s*image:\s*'([^']*)',\s*location:\s*'((?:\\'|[^'])*)',\s*established:\s*'((?:\\'|[^'])*)'\s*\}/g;
  let m;
  while ((m = blockRe.exec(raw)) !== null) {
    map.set(m[1], {
      title: m[2].replace(/\\'/g, "'").trim(),
      subtitle: m[3].replace(/\\'/g, "'").trim(),
      excerpt: m[4].replace(/\\'/g, "'").trim(),
      cardImage: m[5],
      location: m[6].replace(/\\'/g, "'").trim(),
      established: m[7].replace(/\\'/g, "'").trim(),
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
    .replace(/<br\s*\/?>/gi, '<br/>');
  html = html.replace(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, '<a href="$1">$2</a>');
  html = html.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/g, '<strong>$1</strong>');
  html = html.replace(/<(?!\/strong>|strong |\/a>|a |br\b)[^>]+>/gi, '');
  return html.replace(/\s+/g, ' ').trim();
}

function parseProseSection(section) {
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
  return parts.length ? parts.join('\n') : null;
}

function extractContactFields(raw) {
  const contactIdx = raw.search(/Contact Us|For Communications/);
  if (contactIdx < 0) return { address: null, email: null, phones: null, website: null };

  const contactSection = raw.slice(contactIdx, contactIdx + 4000);
  const plain = contactSection
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

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
  const telMatch = plain.match(/Tel\.?:?\s*([^E]+?)(?:E-Mail|Fax|$)/i);
  if (telMatch) {
    phones.push(telMatch[1].replace(/\s+/g, ' ').trim());
  }
  const faxMatch = plain.match(/Fax:?\s*([0-9\-,\s]+)/i);
  if (faxMatch) phones.push(`Fax: ${faxMatch[1].trim()}`);

  let address = null;
  const addrMatch = contactSection.match(
    /P\.?\s*B\.?\s*No\.?[\s\S]*?(?:Kerala|India|Nagpur)[^<]*/i
  );
  if (addrMatch) {
    address = addrMatch[0]
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  } else {
    const stMatch = contactSection.match(
      /St\.?\s*Thomas Orthodox[\s\S]*?India/i
    );
    if (stMatch) {
      address = stMatch[0]
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }

  return {
    address,
    email: emails.length ? emails.join(', ') : null,
    phones: phones.length ? phones.join('; ') : null,
    website,
  };
}

function parseDetailPage(slug) {
  const pagePath = path.join(SEMINARY_PAGES, slug, 'page.tsx');
  if (!fs.existsSync(pagePath)) return null;
  const raw = fs.readFileSync(pagePath, 'utf8');

  const bannerMatch = raw.match(/SyroPageBanner title="([^"]+)"/);
  const imageMatch = raw.match(/<Image[^>]+src="([^"]+)"/);

  const contactIdx = raw.search(/Contact Us|For Communications/);
  const mainEnd = contactIdx >= 0 ? contactIdx : raw.indexOf('TheologicalSeminariesSidebar');
  const mainSection = raw.slice(0, mainEnd > 0 ? mainEnd : raw.length);

  const introIdx = mainSection.indexOf('space-y-6 font-syro-primary');
  const section = introIdx >= 0 ? mainSection.slice(introIdx) : mainSection;
  const bodyHtml = parseProseSection(section);
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

  if (ref.startsWith('/images/theological/')) {
    const base = path.basename(ref);
    candidates.push(path.join(PUBLIC_THEOLOGICAL_IMAGES, base));
    candidates.push(findFileCaseInsensitive(PUBLIC_THEOLOGICAL_IMAGES, base));
  }
  if (ref.startsWith('/images/')) {
    candidates.push(path.join(MOSC_ROOT, 'public', ref.replace(/^\//, '').replace(/\//g, path.sep)));
    const base = path.basename(ref);
    candidates.push(findFileCaseInsensitive(PUBLIC_THEOLOGICAL_IMAGES, base));
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
  if (!fs.existsSync(SEMINARY_PAGES)) return slugs;
  for (const ent of fs.readdirSync(SEMINARY_PAGES, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name === 'components') continue;
    const pagePath = path.join(SEMINARY_PAGES, ent.name, 'page.tsx');
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
  console.log('Theological Seminaries import from mosc-temp');
  console.log('  MOSC_ROOT:', MOSC_ROOT);
  console.log('  TENANT_ID:', TENANT_ID);
  if (DRY_RUN) console.log('  DRY_RUN=1');
  if (REPLACE) console.log('  --replace: update existing slugs');
  if (IMAGES_ONLY) console.log('  --images-only: replace images only');
  console.log('');

  if (!fs.existsSync(MOSC_ROOT)) {
    console.error('MOSC_TEMP_DIR not found:', MOSC_ROOT);
    process.exit(1);
  }

  const hubMeta = loadHubMeta();
  const slugs = discoverDetailSlugs();
  console.log('Hub seminaries (page.tsx):', hubMeta.size);
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
    let imageRefUsed = null;
    for (const ref of imageCandidates) {
      if (!ref) continue;
      imageFile = resolveImageFile(ref);
      if (imageFile) {
        imageRefUsed = ref;
        break;
      }
    }

    const prev = bySlug.get(slug);
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
          console.log('Image updated:', slug);
          updated++;
        } else {
          skipped++;
        }
      } else {
        skipped++;
      }
      continue;
    }

    const data = {
      name,
      slug,
      subtitle: hub.subtitle || null,
      excerpt,
      body: detail.bodyHtml || null,
      location: hub.location || null,
      established: hub.established || null,
      address: detail.address,
      email: detail.email,
      phones: detail.phones,
      website: detail.website,
      order,
      tenant: connectTenant,
    };

    if (prev && !REPLACE) {
      console.log('Skip (exists):', slug);
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log('Would import:', slug, '|', name.slice(0, 45), '| image:', imageFile ? path.basename(imageFile) : 'none');
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
  process.exit(1);
});
