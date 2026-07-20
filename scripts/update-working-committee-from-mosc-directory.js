'use strict';

/**
 * Scrape Working Committee from directory.mosc.in and upsert into
 * Directory – Working Committee (api::working-committee.working-committee).
 *
 * Creates missing members, updates address/email/phones/order, and links images.
 *
 *   node scripts/update-working-committee-from-mosc-directory.js
 *   node scripts/update-working-committee-from-mosc-directory.js --tenant-id=tenant_demo_002
 *   node scripts/update-working-committee-from-mosc-directory.js --tenant-id=mosc_malankara_orthodox_2
 *   DRY_RUN=1 node scripts/update-working-committee-from-mosc-directory.js
 */

try {
  require('dotenv').config();
} catch (_) {}

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');
const mime = require('mime-types');

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const LIVE_URL = 'https://directory.mosc.in/directories/?type=working-committee';
const LIVE_BASE = 'https://directory.mosc.in';
const UID = 'api::working-committee.working-committee';

const TENANT_IDS = (() => {
  const m = process.argv.find((a) => a.startsWith('--tenant-id='));
  if (m) return [m.split('=')[1].trim()].filter(Boolean);
  return ['tenant_demo_002', 'mosc_malankara_orthodox_2'];
})();

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

function text($el) {
  return $el.text().trim().replace(/\s+/g, ' ');
}

function extractEmail($, $wrap) {
  const p = $wrap.find('p').filter((_, el) => $(el).find('.glyphicon-envelope').length);
  if (!p.length) return null;
  const hrefs = $(p[0])
    .find('a[href^="mailto:"]')
    .map((_, a) => $(a).attr('href').replace(/^mailto:/i, '').trim())
    .get()
    .filter(Boolean);
  if (hrefs.length) return hrefs.join(', ');
  const raw = text($(p[0]).clone().children().remove().end()).replace(/^:\s*/, '').trim();
  return raw || null;
}

function extractPhones($, $wrap) {
  const p = $wrap.find('p').filter((_, el) => $(el).find('.glyphicon-earphone').length);
  if (!p.length) return null;
  const links = $(p[0]).find('a[href^="tel:"]');
  const phones = links.map((_, a) => $(a).text().trim()).get().filter(Boolean);
  if (phones.length) return phones.join(', ');
  const raw = text($(p[0]).clone().children().remove().end()).replace(/^:\s*/, '');
  return raw || null;
}

function extractAddress($, $wrap) {
  const paragraphs = $wrap.find('p');
  for (let i = 0; i < paragraphs.length; i++) {
    const p = $(paragraphs[i]);
    if (p.find('.glyphicon-envelope, .glyphicon-earphone, .glyphicon-globe').length) continue;
    const t = text(p);
    if (t && t.length > 3) return t;
  }
  return null;
}

function absoluteUrl(src) {
  if (!src) return null;
  if (/^https?:\/\//i.test(src)) return src.replace(/^http:\/\//i, 'https://');
  if (src.startsWith('//')) return `https:${src}`;
  return `${LIVE_BASE}${src.startsWith('/') ? '' : '/'}${src}`;
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'StrapiWorkingCommitteeUpdate/1.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function downloadImageToTemp(imageUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(imageUrl);
    const baseName = path.basename(parsed.pathname) || 'image.jpg';
    const tempPath = path.join(
      os.tmpdir(),
      `strapi-wc-${Date.now()}-${baseName.replace(/[^a-zA-Z0-9.-]/g, '_')}`
    );
    const file = fs.createWriteStream(tempPath);
    const req = https.get(imageUrl, { headers: { 'User-Agent': 'StrapiWorkingCommitteeUpdate/1.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try {
          fs.unlinkSync(tempPath);
        } catch (_) {}
        downloadImageToTemp(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(tempPath, () => {});
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(tempPath)));
    });
    req.on('error', (err) => {
      file.close();
      try {
        fs.unlinkSync(tempPath);
      } catch (_) {}
      reject(err);
    });
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function scrapeWorkingCommittee(html) {
  const $ = cheerio.load(html);
  const items = [];
  let order = 0;

  function pushEntry(art) {
    const wrap = art.find('.content-wrap').length ? art.find('.content-wrap') : art;
    const h3 = wrap.find('h3 a').first();
    const name = text(h3) || text(wrap.find('h3').first());
    if (!name) return;
    const img =
      art.find('img.wp-post-image').attr('src') ||
      art.find('a figure img').attr('src') ||
      art.find('figure img').attr('src') ||
      (art.find('img').first().length ? art.find('img').first().attr('src') : null);
    items.push({
      name,
      slug: slugify(name),
      address: extractAddress($, wrap) || null,
      email: extractEmail($, wrap) || null,
      phones: extractPhones($, wrap) || null,
      order: order++,
      imageUrl: absoluteUrl(img),
    });
  }

  $('article.directories-item').each((_, article) => pushEntry($(article)));
  if (items.length === 0) {
    $('article').each((_, article) => pushEntry($(article)));
  }
  return items;
}

function effectiveSlug(baseSlug, tenantId) {
  if (tenantId === 'mosc_malankara_orthodox_2') return `${baseSlug}-mo2`;
  return baseSlug;
}

async function uploadImage(strapi, imageUrl, alt) {
  if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) return null;
  const secureUrl = imageUrl.replace(/^http:\/\//i, 'https://');
  if (/dioceses-default|default-image|default_logo/i.test(secureUrl)) return null;
  let tempPath;
  try {
    tempPath = await downloadImageToTemp(secureUrl);
    const stats = fs.statSync(tempPath);
    const ext = path.extname(tempPath).slice(1) || 'jpg';
    const mimetype = mime.lookup(ext) || 'image/jpeg';
    const name = path.basename(tempPath, path.extname(tempPath));
    const [uploaded] = await strapi.plugin('upload').service('upload').upload({
      data: {
        fileInfo: {
          name,
          alternativeText: alt || name,
          caption: alt || name,
        },
      },
      files: {
        filepath: tempPath,
        originalFileName: path.basename(tempPath),
        size: stats.size,
        mimetype,
      },
    });
    return uploaded?.documentId ?? uploaded?.document_id ?? uploaded?.id ?? null;
  } catch (e) {
    console.warn('  Image upload failed:', imageUrl.slice(0, 80), e.message);
    return null;
  } finally {
    if (tempPath) {
      try {
        fs.unlinkSync(tempPath);
      } catch (_) {}
    }
  }
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

async function main() {
  console.log('Working Committee update from directory.mosc.in');
  console.log('  Source:', LIVE_URL);
  console.log('  Tenants:', TENANT_IDS.join(', '));
  if (DRY_RUN) console.log('  DRY_RUN=1');

  const html = await fetchUrl(LIVE_URL);
  const scraped = scrapeWorkingCommittee(html);
  console.log('  Scraped members:', scraped.length);
  for (const item of scraped) {
    console.log(
      `   - [${item.order}] ${item.name} | email=${item.email || '-'} | phone=${item.phones || '-'} | image=${item.imageUrl ? 'yes' : 'no'}`
    );
  }

  if (scraped.length === 0) {
    console.error('No members scraped; aborting.');
    process.exit(1);
  }

  if (DRY_RUN) {
    process.exit(0);
  }

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const app = await createStrapi(await compileStrapi()).load();
  app.log.level = 'error';

  let created = 0;
  let updated = 0;
  let imagesLinked = 0;
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

      for (const item of scraped) {
        const slug = effectiveSlug(item.slug, tenantId);
        const existing = await app.documents(UID).findFirst({
          filters: { slug },
          populate: { image: true, tenant: true },
        });

        const payload = {
          name: item.name,
          slug,
          address: item.address,
          email: item.email,
          phones: item.phones,
          order: item.order,
          tenant: tenantDocId,
        };

        try {
          let docId = existing?.documentId ?? existing?.document_id;
          const needsImage =
            !existing?.image ||
            /dioceses-default|default-image|default_logo/i.test(existing?.image?.url || '');

          if (existing) {
            const patch = {};
            if (!existing.address && item.address) patch.address = item.address;
            if (!existing.email && item.email) patch.email = item.email;
            if (!existing.phones && item.phones) patch.phones = item.phones;
            // Always refresh contact fields from source when present (fill/correct missing/stale)
            if (item.address) patch.address = item.address;
            if (item.email) patch.email = item.email;
            if (item.phones) patch.phones = item.phones;
            if (typeof item.order === 'number') patch.order = item.order;
            if (!existing.tenant) patch.tenant = tenantDocId;

            await app.documents(UID).update({
              documentId: docId,
              data: patch,
            });
            updated++;
            console.log('Updated:', slug);
          } else {
            const createdDoc = await app.documents(UID).create({ data: payload });
            docId = createdDoc?.documentId ?? createdDoc?.document_id ?? createdDoc?.id;
            created++;
            console.log('Created:', slug);
          }

          if (docId && needsImage && item.imageUrl) {
            const fileDocId = await uploadImage(app, item.imageUrl, item.name);
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
              console.log('  Image linked:', slug);
            }
          }
        } catch (e) {
          console.warn('Failed:', slug, e.message);
          skipped++;
        }
      }
    }
  } finally {
    await app.destroy();
  }

  console.log('\nDone. Created:', created, 'Updated:', updated, 'Images linked:', imagesLinked, 'Skipped:', skipped);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
