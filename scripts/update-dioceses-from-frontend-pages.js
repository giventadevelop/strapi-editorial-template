'use strict';

/**
 * Sync Strapi Directory – Dioceses (api::diocese.diocese) from the frontend
 * marketing pages under mosc-temp /mosc-redesign/dioceses.
 *
 * Sources:
 *   - Listing cards: name, excerpt → description, card image
 *   - Detail pages: Office address, email, phones, longer prose (optional)
 *   - Local files: mosc-temp/public/images/dioceses/*
 *
 * Usage:
 *   node scripts/update-dioceses-from-frontend-pages.js
 *   node scripts/update-dioceses-from-frontend-pages.js --tenant-id=tenant_demo_002
 *   DRY_RUN=1 node scripts/update-dioceses-from-frontend-pages.js
 *
 * Stop local Strapi before running (embeds Strapi against local DB).
 */

try {
  require('dotenv').config();
} catch (_) {}

const fs = require('fs');
const path = require('path');
const mime = require('mime-types');

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const UID = 'api::diocese.diocese';
const FORCE_CONTACTS = process.argv.includes('--force-contacts');
const FORCE_IMAGES = process.argv.includes('--force-images');

const FRONTEND_ROOT = process.env.MOSC_TEMP_ROOT
  ? path.resolve(process.env.MOSC_TEMP_ROOT)
  : path.resolve(__dirname, '..', '..', 'mosc-temp');
const DIOCESES_APP = path.join(
  FRONTEND_ROOT,
  'src',
  'app',
  'mosc-redesign',
  '(syro)',
  'dioceses'
);
const PUBLIC_ROOT = path.join(FRONTEND_ROOT, 'public');

const TENANT_IDS = (() => {
  const m = process.argv.find((a) => a.startsWith('--tenant-id='));
  if (m) return [m.split('=')[1].trim()].filter(Boolean);
  return ['tenant_demo_002', 'mosc_malankara_orthodox_2'];
})();

/** Normalize for fuzzy name match (Angamaly/Ankamaly, Madras/Chennai, etc.). */
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/diocese of\s+/g, '')
    .replace(/diocese\s+/g, '')
    .replace(/chennai/g, 'madras')
    .replace(/mumbai/g, 'bombay')
    .replace(/angamaly/g, 'ankamaly')
    .replace(/brahmavar/g, 'brahamavar')
    .replace(/sultan\s*bathery/g, 'sulthan bathery')
    .replace(/kadampanad\b/g, 'kadampanadu')
    .replace(/kottarakkara/g, 'kottarakara')
    .replace(/north[\s-]*east/g, 'northeast')
    .replace(/south[\s-]*west/g, 'southwest')
    .replace(/uk[\s,-]*europe[\s,-]*and[\s,-]*africa/g, 'uk europe africa')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

function effectiveSlug(baseSlug, tenantId) {
  if (tenantId === 'mosc_malankara_orthodox_2') return `${baseSlug}-mo2`;
  return baseSlug;
}

function decodeJsString(s) {
  return String(s || '')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .trim();
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseListingCards() {
  const listingPath = path.join(DIOCESES_APP, 'page.tsx');
  if (!fs.existsSync(listingPath)) {
    throw new Error(`Listing page not found: ${listingPath}`);
  }
  const src = fs.readFileSync(listingPath, 'utf8');
  const cards = [];
  const re =
    /\{\s*name:\s*'((?:\\'|[^'])*)'\s*,\s*href:\s*'((?:\\'|[^'])*)'\s*,\s*excerpt:\s*'((?:\\'|[^'])*)'\s*,\s*image:\s*'((?:\\'|[^'])*)'\s*\}/g;
  let m;
  while ((m = re.exec(src))) {
    cards.push({
      name: decodeJsString(m[1]),
      href: decodeJsString(m[2]),
      excerpt: decodeJsString(m[3]),
      image: decodeJsString(m[4]) || null,
      detailSlug: decodeJsString(m[2]).split('/').filter(Boolean).pop(),
    });
  }
  return cards;
}

function parseDetailPage(detailSlug) {
  const pagePath = path.join(DIOCESES_APP, detailSlug, 'page.tsx');
  if (!fs.existsSync(pagePath)) return null;
  const src = fs.readFileSync(pagePath, 'utf8');

  const emailMatch = src.match(/mailto:([^"'\\\s>]+)/i);
  const email = emailMatch ? emailMatch[1].trim() : null;

  const phoneLinks = [...src.matchAll(/tel:([^"'\\\s>]+)/gi)].map((x) => x[1].trim());
  let phones = phoneLinks.length ? phoneLinks.join(', ') : null;
  if (!phones) {
    const phoneLabel = src.match(
      /(?:Phone|Ph|Tel)(?:ephone)?\s*:?\s*<\/span>\s*([^<\n]+)/i
    );
    if (phoneLabel) phones = phoneLabel[1].replace(/&apos;/g, "'").trim() || null;
  }

  let address = null;
  const officeBlock = src.match(
    /font-semibold">Office:<\/span>[\s\S]*?<br[\s\S]*?\/?>\s*([\s\S]*?)\s*<\/p>/i
  );
  if (officeBlock) {
    address = stripHtml(officeBlock[1]);
  }

  const paragraphs = [...src.matchAll(/<p className="font-syro-primary[^"]*">([\s\S]*?)<\/p>/g)]
    .map((x) => stripHtml(x[1]))
    .filter((t) => t && t.length > 40 && !/^Office:/i.test(t) && !/^E-mail:/i.test(t));

  const longDescription = paragraphs.length ? paragraphs.join('\n\n') : null;

  const imgMatch = src.match(/src="(\/images\/dioceses\/[^"]+)"/);
  const detailImage = imgMatch ? imgMatch[1] : null;

  const websiteMatch = src.match(
    /href="(https?:\/\/(?!maps\.|www\.google|goo\.gl)[^"]+)"/i
  );
  const website =
    websiteMatch && !/mailto:|maps\.app\.goo|google\.com\/maps/i.test(websiteMatch[1])
      ? websiteMatch[1]
      : null;

  return { email, phones, address, longDescription, detailImage, website };
}

function resolveLocalImage(relPath) {
  if (!relPath) return null;
  const abs = path.join(PUBLIC_ROOT, relPath.replace(/^\//, ''));
  if (!fs.existsSync(abs)) return null;
  const stats = fs.statSync(abs);
  // Skip tiny placeholder files (~1.6KB)
  if (stats.size < 3000) return null;
  return abs;
}

function collectFrontendDioceses() {
  const cards = parseListingCards();
  return cards.map((card, index) => {
    const detail = card.detailSlug ? parseDetailPage(card.detailSlug) : null;
    const imageRel = card.image || detail?.detailImage || null;
    const imageAbs = resolveLocalImage(imageRel);
    const description =
      (detail?.longDescription && detail.longDescription.slice(0, 8000)) ||
      card.excerpt ||
      null;
    return {
      order: index + 1,
      name: card.name,
      baseSlug: slugify(card.name),
      matchKey: normalizeName(card.name),
      excerpt: card.excerpt,
      description,
      address: detail?.address || null,
      email: detail?.email || null,
      phones: detail?.phones || null,
      website: detail?.website || null,
      imageRel,
      imageAbs,
    };
  });
}

async function uploadLocalImage(strapi, absPath, alt) {
  const stats = fs.statSync(absPath);
  const ext = path.extname(absPath).slice(1) || 'jpg';
  const mimetype = mime.lookup(ext) || 'image/jpeg';
  const name = path.basename(absPath, path.extname(absPath));
  const [uploaded] = await strapi.plugin('upload').service('upload').upload({
    data: {
      fileInfo: {
        name,
        alternativeText: alt || name,
        caption: alt || name,
      },
    },
    files: {
      filepath: absPath,
      originalFileName: path.basename(absPath),
      size: stats.size,
      mimetype,
    },
  });
  return uploaded?.documentId ?? uploaded?.document_id ?? uploaded?.id ?? null;
}

async function setMediaRelationViaDb(strapi, entityDocumentId, fileDocumentId) {
  if (!entityDocumentId || !fileDocumentId) return false;
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
  await db('files_related_mph')
    .where({ related_id: entityRow.id, related_type: UID, field: 'image' })
    .del();
  await db('files_related_mph').insert({
    file_id: fileRow.id,
    related_id: entityRow.id,
    related_type: UID,
    field: 'image',
    order: 1,
  });
  return true;
}

function findBestMatch(existingRows, item) {
  const exact = existingRows.find((r) => normalizeName(r.name) === item.matchKey);
  if (exact) return exact;
  // Containment / high overlap
  const keyParts = new Set(item.matchKey.split(' ').filter((w) => w.length > 2));
  let best = null;
  let bestScore = 0;
  for (const row of existingRows) {
    const rowKey = normalizeName(row.name);
    if (!rowKey) continue;
    if (rowKey.includes(item.matchKey) || item.matchKey.includes(rowKey)) {
      return row;
    }
    const parts = rowKey.split(' ').filter((w) => w.length > 2);
    const overlap = parts.filter((p) => keyParts.has(p)).length;
    const score = overlap / Math.max(parts.length, keyParts.size, 1);
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  return bestScore >= 0.6 ? best : null;
}

async function main() {
  console.log('Update dioceses from frontend mosc-redesign/dioceses pages');
  console.log('  Frontend root:', FRONTEND_ROOT);
  console.log('  Tenants:', TENANT_IDS.join(', '));
  if (DRY_RUN) console.log('  DRY_RUN=1');
  if (FORCE_CONTACTS) console.log('  --force-contacts');
  if (FORCE_IMAGES) console.log('  --force-images');

  if (!fs.existsSync(DIOCESES_APP)) {
    console.error('Dioceses app folder not found:', DIOCESES_APP);
    process.exit(1);
  }

  const items = collectFrontendDioceses();
  console.log('  Frontend dioceses:', items.length);
  for (const item of items) {
    console.log(
      `   - ${item.name} | desc=${item.description ? 'yes' : 'no'} | email=${item.email || '-'} | addr=${item.address ? 'yes' : 'no'} | img=${item.imageAbs ? path.basename(item.imageAbs) : '-'}`
    );
  }
  if (items.length === 0) {
    console.error('No frontend dioceses parsed; aborting.');
    process.exit(1);
  }
  if (DRY_RUN) process.exit(0);

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const app = await createStrapi(await compileStrapi()).load();
  app.log.level = 'error';

  let created = 0;
  let updated = 0;
  let imagesLinked = 0;
  let unmatched = 0;
  let skipped = 0;

  try {
    for (const tenantId of TENANT_IDS) {
      const tenant = await app.db.query('api::tenant.tenant').findOne({
        where: { tenantId },
        select: ['id', 'documentId', 'tenantId'],
      });
      if (!tenant) {
        console.warn('Tenant not found locally:', tenantId);
        skipped++;
        continue;
      }
      const tenantDocId = tenant.documentId ?? tenant.document_id ?? tenant.id;
      console.log(`\n=== Tenant ${tenantId} ===`);

      const allForTenant = await app.documents(UID).findMany({
        filters: { tenant: { tenantId: { $eq: tenantId } } },
        populate: { image: true, tenant: true },
        pagination: { pageSize: 200 },
      });
      console.log('  Existing dioceses:', allForTenant.length);

      const usedDocIds = new Set();

      for (const item of items) {
        let existing = findBestMatch(
          allForTenant.filter((r) => !usedDocIds.has(r.documentId)),
          item
        );
        if (existing) usedDocIds.add(existing.documentId);

        const slug = existing?.slug || effectiveSlug(item.baseSlug, tenantId);
        const needsImage =
          FORCE_IMAGES ||
          !existing?.image ||
          /dioceses-default|default-image|default_logo/i.test(existing?.image?.url || '');

        try {
          if (existing) {
            const patch = {};
            if (item.description) patch.description = item.description;
            if (item.address && (FORCE_CONTACTS || !existing.address)) patch.address = item.address;
            if (item.email && (FORCE_CONTACTS || !existing.email)) patch.email = item.email;
            if (item.phones && (FORCE_CONTACTS || !existing.phones)) patch.phones = item.phones;
            if (item.website && (FORCE_CONTACTS || !existing.website)) patch.website = item.website;
            if (!existing.tenant) patch.tenant = tenantDocId;

            if (Object.keys(patch).length) {
              await app.documents(UID).update({
                documentId: existing.documentId,
                data: patch,
              });
              updated++;
              console.log('Updated:', existing.name, '→', item.name);
            } else {
              console.log('No text changes:', existing.name);
            }

            if (needsImage && item.imageAbs) {
              const fileDocId = await uploadLocalImage(app, item.imageAbs, item.name);
              if (fileDocId) {
                try {
                  await app.documents(UID).update({
                    documentId: existing.documentId,
                    data: { image: fileDocId },
                  });
                } catch (_) {
                  await setMediaRelationViaDb(app, existing.documentId, fileDocId);
                }
                imagesLinked++;
                console.log('  Image linked:', path.basename(item.imageAbs));
              }
            }
          } else {
            unmatched++;
            const payload = {
              name: item.name,
              slug,
              description: item.description,
              address: item.address,
              email: item.email,
              phones: item.phones,
              website: item.website,
              tenant: tenantDocId,
            };
            const createdDoc = await app.documents(UID).create({ data: payload });
            const docId = createdDoc?.documentId ?? createdDoc?.document_id ?? createdDoc?.id;
            created++;
            console.log('Created (was missing):', slug);

            if (docId && item.imageAbs) {
              const fileDocId = await uploadLocalImage(app, item.imageAbs, item.name);
              if (fileDocId) {
                try {
                  await app.documents(UID).update({
                    documentId: docId,
                    data: { image: fileDocId },
                  });
                } catch (_) {
                  await setMediaRelationViaDb(app, docId, fileDocId);
                }
                imagesLinked++;
                console.log('  Image linked:', path.basename(item.imageAbs));
              }
            }
          }
        } catch (e) {
          console.warn('Failed:', item.name, e.message);
          skipped++;
        }
      }
    }
  } finally {
    await app.destroy();
  }

  console.log(
    '\nDone. Created:',
    created,
    'Updated:',
    updated,
    'Images linked:',
    imagesLinked,
    'Created-as-missing:',
    unmatched,
    'Skipped:',
    skipped
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
