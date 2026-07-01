'use strict';

/**
 * Import Current Catholicos homepage profile from mosc-temp into Directory – Current Catholicos.
 * Creates/updates entries only in this collection type.
 *
 * Sources:
 *   - MoscRedesignHomeClient.tsx (mainContent section[2] — Catholicos profile block)
 *   - holy-synod/<slug>/page.tsx for full biography and contact
 *   - public/images/holy-synod/*
 *
 * Env:
 *   MOSC_TEMP_DIR     (default: C:\project_workspace\mosc-temp)
 *   TENANT_ID         (default: tenant_demo_002)
 *   DRY_RUN=1         Preview only
 *   --replace         Update existing rows for same slug+tenant
 *   --images-only     Replace image media only (no text/content changes)
 *   --slug-suffix=-mo2  Append to slug when tenant shares instance (auto for mosc_malankara_orthodox_2)
 *
 *   node scripts/import-current-catholicos-from-mosc-temp.js
 *   node scripts/import-current-catholicos-from-mosc-temp.js --tenant-id=mosc_malankara_orthodox_2 --replace
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
const HOMEPAGE_CLIENT = path.join(MOSC_ROOT, 'src', 'app', 'mosc-redesign', 'MoscRedesignHomeClient.tsx');
const HOLYSYNOD_PAGES = path.join(MOSC_ROOT, 'src', 'app', 'mosc-redesign', '(syro)', 'holy-synod');
const PUBLIC_HOLYSYNOD_IMAGES = path.join(MOSC_ROOT, 'public', 'images', 'holy-synod');

const UID = 'api::current-catholicos.current-catholicos';

function effectiveSlug(baseSlug) {
  return `${baseSlug}${SLUG_SUFFIX}`;
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

function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function jsxInlineToHtml(content) {
  let html = content
    .replace(/\{' '\}/g, ' ')
    .replace(/\{`([^`]*)`\}/g, '$1')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
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

function loadHomepageProfile() {
  if (!fs.existsSync(HOMEPAGE_CLIENT)) return null;
  const raw = fs.readFileSync(HOMEPAGE_CLIENT, 'utf8');
  const sectionMatch = raw.match(
    /{\/\* ── CATHOLICOS PROFILE[\s\S]*?<section[^>]*>([\s\S]*?)<\/section>/
  );
  if (!sectionMatch) return null;
  const section = sectionMatch[1];

  const imageMatch = section.match(/src="([^"]+)"[\s\S]*?alt="((?:\\"|[^"])*)"/);
  const badgeMatch = section.match(
    /<span className="inline-block text-warmGold-dark[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/span>/
  );
  const roleMatch = section.match(
    /<p className="text-burgundy text-sm font-medium mb-2">([\s\S]*?)<\/p>/
  );
  const excerptMatch = section.match(
    /<p className="text-warmGray-dark leading-relaxed mb-8 text-base">\s*([\s\S]*?)\s*<\/p>/
  );
  const profileMatch = section.match(/href="(\/mosc-redesign\/holy-synod\/[^"]+)"/);

  const h2Match = section.match(
    /<h2 className="text-3xl md:text-4xl font-bold text-warmBrown-dark mb-6 leading-tight">\s*([\s\S]*?)<\/h2>/
  );
  let name = '';
  if (h2Match) {
    name = h2Match[1]
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<span[^>]*>([\s\S]*?)<\/span>/gi, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const profilePath = profileMatch?.[1] || null;
  const baseSlug = profilePath ? profilePath.split('/').filter(Boolean).pop() : null;
  if (!baseSlug) return null;

  return {
    baseSlug,
    name: name || 'Current Catholicos',
    badge: badgeMatch ? stripTags(badgeMatch[1]) : null,
    roleTitle: roleMatch ? stripTags(roleMatch[1]) : null,
    excerpt: excerptMatch ? stripTags(excerptMatch[1]) : null,
    homepageImage: imageMatch?.[1] || null,
    imageAlt: imageMatch?.[2] ? imageMatch[2].replace(/\\"/g, '"').trim() : null,
    profilePath,
  };
}

function parseDetailPage(slug) {
  const pagePath = path.join(HOLYSYNOD_PAGES, slug, 'page.tsx');
  if (!fs.existsSync(pagePath)) return null;
  const raw = fs.readFileSync(pagePath, 'utf8');

  const bannerMatch = raw.match(/SyroPageBanner[\s\S]*?title="([^"]+)"/);
  const imageMatch = raw.match(/<Image[^>]+src="([^"]+)"/);

  const proseIdx = raw.indexOf('className="prose');
  const endMarkers = ['QuickLinks', 'SynodMembersSidebar', 'lg:col-span-1'];
  let endIdx = raw.length;
  for (const marker of endMarkers) {
    const i = raw.indexOf(marker, proseIdx >= 0 ? proseIdx : 0);
    if (i > (proseIdx >= 0 ? proseIdx : 0) && i < endIdx) endIdx = i;
  }
  const section = proseIdx >= 0 ? raw.slice(proseIdx, endIdx) : raw;
  const bodyHtml = parseProseSection(section);

  let address = null;
  let email = null;
  let phones = null;
  const contactBlock = raw.match(/Contact[\s\S]*?<div className="mt-8 pt-6 border-t[\s\S]*?<\/div>\s*<\/div>/i);
  if (contactBlock) {
    const lines = [];
    const pRe = /<p className="font-syro-primary[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;
    let pm;
    while ((pm = pRe.exec(contactBlock[0])) !== null) {
      const line = stripTags(jsxInlineToHtml(pm[1]));
      if (line) lines.push(line);
    }
    const emailLine = lines.find((l) => /catholicos@/i.test(l) || /^Email:/i.test(l));
    const phoneLine = lines.find((l) => /^Tel:/i.test(l));
    if (emailLine) {
      const m = emailLine.match(/([^\s]+@[^\s]+)/);
      email = m ? m[1] : emailLine.replace(/^Email:\s*/i, '').trim();
    }
    if (phoneLine) {
      phones = phoneLine.replace(/^Tel:\s*/i, '').trim();
    }
    const addressLines = lines.filter(
      (l) => l !== emailLine && l !== phoneLine && !/^Facebook:/i.test(l) && !/^Instagram:/i.test(l) && !/^H\.H\./i.test(l)
    );
    if (addressLines.length) address = addressLines.join('\n');
  }

  return {
    bannerTitle: bannerMatch?.[1]?.trim() || null,
    detailImage: imageMatch?.[1] || null,
    bodyHtml,
    address,
    email,
    phones,
  };
}

function resolveImageFile(imageRef) {
  if (!imageRef || typeof imageRef !== 'string') return null;
  const ref = imageRef.trim();
  const candidates = [];

  if (ref.startsWith('/images/holy-synod/')) {
    const base = path.basename(ref);
    candidates.push(path.join(PUBLIC_HOLYSYNOD_IMAGES, base));
    candidates.push(findFileCaseInsensitive(PUBLIC_HOLYSYNOD_IMAGES, base));
  }
  if (ref.startsWith('/images/')) {
    candidates.push(path.join(MOSC_ROOT, 'public', ref.replace(/^\//, '').replace(/\//g, path.sep)));
    const base = path.basename(ref);
    candidates.push(findFileCaseInsensitive(PUBLIC_HOLYSYNOD_IMAGES, base));
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

async function uploadLocalImage(strapi, filePath, altText) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const stats = fs.statSync(filePath);
    const ext = path.extname(filePath).slice(1) || 'jpg';
    const mimetype = mime.lookup(ext) || 'image/jpeg';
    const name = path.basename(filePath, path.extname(filePath));
    const alt = altText || name;
    const [uploaded] = await strapi.plugin('upload').service('upload').upload({
      data: { fileInfo: { name, alternativeText: alt, caption: alt } },
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

async function main() {
  console.log('Current Catholicos import from mosc-temp');
  console.log('  MOSC_ROOT:', MOSC_ROOT);
  console.log('  TENANT_ID:', TENANT_ID);
  if (SLUG_SUFFIX) console.log('  SLUG_SUFFIX:', SLUG_SUFFIX);
  if (DRY_RUN) console.log('  DRY_RUN=1');
  if (REPLACE) console.log('  --replace: update existing slugs');
  if (IMAGES_ONLY) console.log('  --images-only: replace images only');
  console.log('');

  if (!fs.existsSync(MOSC_ROOT)) {
    console.error('MOSC_TEMP_DIR not found:', MOSC_ROOT);
    process.exit(1);
  }

  const homepage = loadHomepageProfile();
  if (!homepage) {
    console.error('Could not parse Current Catholicos section from MoscRedesignHomeClient.tsx');
    process.exit(1);
  }

  const detail = parseDetailPage(homepage.baseSlug);
  if (!detail) {
    console.error('Detail page not found for slug:', homepage.baseSlug);
    process.exit(1);
  }

  const storageSlug = effectiveSlug(homepage.baseSlug);
  const name = homepage.name || detail.bannerTitle || homepage.baseSlug;

  const imageCandidates = [homepage.homepageImage, detail.detailImage];
  let imageFile = null;
  for (const ref of imageCandidates) {
    if (!ref) continue;
    imageFile = resolveImageFile(ref);
    if (imageFile) break;
  }

  console.log('Profile:', name);
  console.log('Slug:', storageSlug);
  console.log('Image:', imageFile ? path.basename(imageFile) : 'none');
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
    limit: 50,
  });
  const existingList = existing?.results ?? existing?.data ?? (Array.isArray(existing) ? existing : []);
  const prev = existingList.find((row) => row.slug === storageSlug);

  if (IMAGES_ONLY) {
    if (!prev) {
      console.warn('Skip (no row for images-only):', storageSlug);
      await app.destroy();
      process.exit(0);
    }
    if (DRY_RUN) {
      console.log('Would replace image for:', storageSlug);
      await app.destroy();
      process.exit(0);
    }
    if (imageFile && prev.documentId) {
      const uploaded = await uploadLocalImage(app, imageFile, homepage.imageAlt);
      if (uploaded?.documentId) {
        try {
          await app.documents(UID).update({
            documentId: prev.documentId,
            data: { image: { connect: [{ documentId: uploaded.documentId }] } },
          });
        } catch (_) {}
        await setMediaRelationViaDb(app, prev.documentId, uploaded.documentId);
        console.log('Image updated:', storageSlug);
      }
    }
    await app.destroy();
    process.exit(0);
  }

  const data = {
    name,
    slug: storageSlug,
    badge: homepage.badge,
    roleTitle: homepage.roleTitle,
    excerpt: homepage.excerpt,
    body: detail.bodyHtml || null,
    imageAlt: homepage.imageAlt,
    profilePath: homepage.profilePath,
    address: detail.address,
    email: detail.email,
    phones: detail.phones,
    order: 0,
    tenant: connectTenant,
  };

  if (prev && !REPLACE) {
    console.log('Skip (exists):', storageSlug);
    await app.destroy();
    process.exit(0);
  }

  if (DRY_RUN) {
    console.log('Would import:', storageSlug, '|', name);
    await app.destroy();
    process.exit(0);
  }

  try {
    let doc;
    if (prev && REPLACE) {
      doc = await app.documents(UID).update({
        documentId: prev.documentId,
        data,
      });
      console.log('Updated:', storageSlug);
    } else {
      doc = await app.documents(UID).create({ data });
      console.log('Created:', storageSlug);
      try {
        await app.db.query(UID).update({
          where: { documentId: doc.documentId },
          data: { tenant: tenant.id },
        });
      } catch (_) {}
    }

    const docId = doc?.documentId ?? prev?.documentId;
    if (imageFile && docId) {
      const uploaded = await uploadLocalImage(app, imageFile, homepage.imageAlt);
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
    console.error('Failed:', storageSlug, e.message);
    await app.destroy();
    process.exit(1);
  }

  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
