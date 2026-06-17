'use strict';

/**
 * Import Directory – Spiritual Organisations from mosc-temp (Next.js pages + images).
 *
 * Sources:
 *   - spiritual-organizations/page.tsx hub cards
 *   - spiritual-organizations/<slug>/page.tsx detail + contact
 *   - public/images/spiritual/* (or fetch from MOSC_DEV_URL / localhost:3000)
 *
 *   npm run import:spiritual-organisations -- --tenant-id=tenant_demo_002 --replace
 */

try {
  require('dotenv').config();
} catch (_) {}

const fs = require('fs');
const path = require('path');
const os = require('os');
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
const ORG_PAGES = path.join(MOSC_ROOT, 'src', 'app', 'mosc-redesign', '(syro)', 'spiritual-organizations');
const PUBLIC_SPIRITUAL = path.join(MOSC_ROOT, 'public', 'images', 'spiritual');
const PUBLIC_LOGOS = path.join(MOSC_ROOT, 'public', 'images', 'logos', 'Current_Edits');
const MOSC_DEV_URL = (process.env.MOSC_DEV_URL || 'http://localhost:3000').replace(/\/$/, '');

const UID = 'api::spiritual-organisation.spiritual-organisation';

const ORG_SLUGS = [
  'orthodox-syrian-sunday-school-association-of-the-east',
  'ecological-commission',
  'divyabodhanam-theological-education-programme-for-the-laity',
  'st-pauls-st-thomas-suvishesha-sangam-national-association-for-mission-studies',
  'orthodox-sabha-gayaka-sangham-co-sruthi-school-of-liturgical-music',
  'malankara-orthodox-baskiyoma-association',
  'the-servants-of-the-cross',
  'ardra-charitable-trust',
  'akhila-malankara-prayer-group-association',
  'akhila-malankara-orthodox-shusrushaka-sangham-amoss',
  'mission-board',
  'ministry-of-human-empowerment',
  'akhila-malankara-bala-samajam',
  'st-thomas-orthodox-vaidika-sanghom',
  'marth-mariam-vanitha-samajam-womens-wing-of-orthodox-church-of-india',
  'mar-gregorios-orthodox-christian-student-movement-mgocsm',
  'the-orthodox-christian-youth-movement',
  'navajyothi-moms-charitable-society',
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
  const hubPath = path.join(ORG_PAGES, 'page.tsx');
  if (!fs.existsSync(hubPath)) return new Map();
  const raw = fs.readFileSync(hubPath, 'utf8');
  const map = new Map();
  let order = 0;

  const blockRe = /\{\s*title:\s*(['"])((?:\\.|(?!\1)[^])*)\1,\s*description:\s*(['"])((?:\\.|(?!\3)[^])*)\3,\s*href:\s*'([^']+)'(?:,\s*image:\s*'([^']*)')?/g;
  let m;
  while ((m = blockRe.exec(raw)) !== null) {
    const href = m[5];
    const slugMatch = href.match(/\/spiritual-organizations\/([^/?#]+)/);
    const slug = slugMatch?.[1];
    if (!slug) continue;
    let cardImage = m[6] || null;
    if (slug === 'orthodox-syrian-sunday-school-association-of-the-east' && !cardImage) {
      cardImage = '/images/spiritual/OSSSAE.png';
    }
    map.set(slug, {
      title: unescapeJsString(m[2]),
      excerpt: unescapeJsString(m[4]),
      cardImage,
      order: order++,
    });
  }
  return map;
}

function jsxInlineToText(content) {
  return content
    .replace(/\{' '\}/g, ' ')
    .replace(/\{`([^`]*)`\}/g, '$1')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lsquo;|&rsquo;|&apos;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseProseParagraphs(section) {
  const parts = [];
  const blockRe = /<(p|li)(?:\s+className="[^"]*")?[^>]*>([\s\S]*?)<\/\1>/gi;
  let bm;
  while ((bm = blockRe.exec(section)) !== null) {
    const text = jsxInlineToText(bm[2]);
    if (text.length >= 15) parts.push(text);
  }
  return parts;
}

function extractContactFields(raw) {
  const contactIdx = raw.search(/Office Bearers|Contact Address|For Communications|Address<\/h3>/i);
  const contactSection = contactIdx >= 0 ? raw.slice(contactIdx, contactIdx + 8000) : raw.slice(-4000);

  const emails = [];
  const mailRe = /mailto:([^"'\s>]+)/gi;
  let em;
  while ((em = mailRe.exec(contactSection)) !== null) {
    if (!emails.includes(em[1])) emails.push(em[1]);
  }

  const websites = [];
  const hrefRe = /href="(https?:\/\/[^"]+)"/gi;
  let hm;
  while ((hm = hrefRe.exec(contactSection)) !== null) {
    if (!hm[1].includes('mailto:') && !websites.includes(hm[1])) websites.push(hm[1]);
  }

  const phones = [];
  const phonePatterns = [
    /Ph\.?:?\s*([+0-9\s\-()]+)/gi,
    /Phone:?\s*([+0-9\s\-()]+)/gi,
    /Mob(?:ile)?\.?:?\s*([+0-9\s\-()]+)/gi,
    /Tel\.?:?\s*([+0-9\s\-()]+)/gi,
  ];
  for (const re of phonePatterns) {
    let pm;
    while ((pm = re.exec(contactSection)) !== null) {
      const val = pm[1].replace(/\s+/g, ' ').trim();
      if (val && val.length >= 6 && !phones.includes(val)) phones.push(val);
    }
  }

  let address = null;
  const addrMatch = contactSection.match(/<address[^>]*>([\s\S]*?)<\/address>/i);
  if (addrMatch) {
    address = jsxInlineToText(addrMatch[1].replace(/<br\s*\/?>/gi, '\n'));
  } else {
    const addrHeading = contactSection.match(
      /(?:Contact Address|Address)<\/h3>\s*<p>([\s\S]*?)<\/p>/i
    );
    if (addrHeading) {
      const lines = [];
      const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
      let started = false;
      let pm;
      const slice = contactSection.slice(contactSection.search(/(?:Contact Address|Address)/i));
      while ((pm = pRe.exec(slice)) !== null) {
        if (!started) {
          started = true;
          continue;
        }
        const line = jsxInlineToText(pm[1]);
        if (!line || /^(Ph|Phone|Email|Website|Mob)/i.test(line)) break;
        lines.push(line);
        if (lines.length >= 6) break;
      }
      if (lines.length) address = lines.join('\n');
    }
  }

  return {
    address,
    email: emails.length ? emails.join(', ') : null,
    phones: phones.length ? phones.join('; ') : null,
    website: websites.length ? websites[0] : null,
  };
}

function parseDetailPage(slug) {
  const pagePath = path.join(ORG_PAGES, slug, 'page.tsx');
  if (!fs.existsSync(pagePath)) return null;
  const raw = fs.readFileSync(pagePath, 'utf8');

  const titleMatch = raw.match(/title="((?:\\.|[^"])*)"/);
  const imageMatch = raw.match(/<Image[^>]+src="([^"]+)"/);

  const contactIdx = raw.search(/Office Bearers|Contact Address/);
  const mainSection = contactIdx >= 0 ? raw.slice(0, contactIdx) : raw;
  const introIdx = mainSection.indexOf('space-y-6 font-syro-primary');
  const paragraphs =
    introIdx >= 0 ? parseProseParagraphs(mainSection.slice(introIdx)) : parseProseParagraphs(mainSection);

  const contact = extractContactFields(raw);

  return {
    layoutTitle: titleMatch ? unescapeJsString(titleMatch[1]) : null,
    detailImage: imageMatch?.[1] || null,
    paragraphs,
    description: paragraphs.length ? paragraphs.join('\n\n') : null,
    ...contact,
  };
}

async function fetchRemoteImage(imageRef) {
  if (!imageRef || !imageRef.startsWith('/')) return null;
  const url = `${MOSC_DEV_URL}${imageRef}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) return null;
    const ext = path.extname(imageRef) || '.jpg';
    const tmp = path.join(os.tmpdir(), `spiritual-import-${Date.now()}-${path.basename(imageRef)}`);
    fs.writeFileSync(tmp, buf);
    return tmp;
  } catch (_) {
    return null;
  }
}

function resolveImageFile(imageRef) {
  if (!imageRef || typeof imageRef !== 'string') return null;
  const ref = imageRef.trim();
  const candidates = [];

  if (ref.startsWith('/images/spiritual/')) {
    const base = path.basename(ref);
    candidates.push(path.join(PUBLIC_SPIRITUAL, base));
    candidates.push(findFileCaseInsensitive(PUBLIC_SPIRITUAL, base));
  }
  if (ref.includes('MOSC-Logo')) {
    const base = path.basename(ref);
    candidates.push(path.join(PUBLIC_LOGOS, base));
    candidates.push(findFileCaseInsensitive(PUBLIC_LOGOS, base));
  }
  if (ref.startsWith('/images/')) {
    candidates.push(path.join(MOSC_ROOT, 'public', ref.replace(/^\//, '').replace(/\//g, path.sep)));
  }

  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch (_) {}
  }
  return null;
}

async function resolveImagePath(imageRef) {
  const local = resolveImageFile(imageRef);
  if (local) return local;
  return fetchRemoteImage(imageRef);
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

async function deleteTenantOrgs(strapi, tenant) {
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
  console.log('Spiritual organisations import from mosc-temp');
  console.log('  MOSC_ROOT:', MOSC_ROOT);
  console.log('  TENANT_ID:', TENANT_ID);
  console.log('  MOSC_DEV_URL (image fallback):', MOSC_DEV_URL);
  if (DRY_RUN) console.log('  DRY_RUN=1');
  if (REPLACE) console.log('  --replace: delete tenant spiritual orgs then import fresh');
  console.log('');

  if (!fs.existsSync(MOSC_ROOT)) {
    console.error('MOSC_TEMP_DIR not found:', MOSC_ROOT);
    process.exit(1);
  }

  const hubMeta = loadHubMeta();
  console.log('Hub organisations (page.tsx):', hubMeta.size);
  console.log('Detail slugs:', ORG_SLUGS.length);
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
    const deleted = await deleteTenantOrgs(app, tenant);
    console.log('Deleted existing spiritual organisations for tenant:', deleted);
  } else if (REPLACE && DRY_RUN) {
    const existing = await app.documents(UID).findMany({ filters: { tenant: tenant.id }, limit: 500 });
    const list = existing?.results ?? existing?.data ?? [];
    console.log('Would delete', list.length, 'existing spiritual organisations for tenant');
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

  for (const slug of ORG_SLUGS) {
    const hub = hubMeta.get(slug) || {};
    const detail = parseDetailPage(slug);
    if (!detail) {
      console.warn('Skip (no detail page):', slug);
      skipped++;
      continue;
    }

    const name = hub.title || detail.layoutTitle || slug;
    const description = detail.description || hub.excerpt || null;
    const order = hub.order != null ? hub.order : orphanOrder++;

    const imageCandidates = [detail.detailImage, hub.cardImage];
    let imageFile = null;
    for (const ref of imageCandidates) {
      if (!ref) continue;
      imageFile = await resolveImagePath(ref);
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
      description,
      address: detail.address,
      email: detail.email,
      phones: detail.phones,
      website: detail.website,
      order,
      tenant: tenant.id,
    };

    if (DRY_RUN) {
      console.log(
        'Would import:',
        slug,
        '|',
        name.slice(0, 55),
        '| image:',
        imageFile ? path.basename(imageFile) : 'none'
      );
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
        if (imageFile.includes(os.tmpdir())) {
          try {
            fs.unlinkSync(imageFile);
          } catch (_) {}
        }
      } else if (!imageFile) {
        console.warn('  No image file for:', slug);
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
