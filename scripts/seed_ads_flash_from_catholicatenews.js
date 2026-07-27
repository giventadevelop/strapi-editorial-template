'use strict';

/**
 * Scrape ads + flash news from https://catholicatenews.in/ and upsert into local Strapi.
 *
 * Positions (frontend mapping):
 *   top              ← header .top-add banner (728×90)
 *   between_sections ← mid-page / “bottom” square promos in main column
 *   sidebar          ← side square promos (300×300)
 *
 * Usage:
 *   npm run seed:ads-flash-catholicatenews
 *   npm run seed:ads-flash-catholicatenews -- --tenants=tenant_demo_002,mosc_malankara_orthodox_2
 *   npm run seed:ads-flash-catholicatenews -- --dry-run
 */

try {
  require('dotenv').config();
} catch (_) {}

const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const mime = require('mime-types');
const cheerio = require('cheerio');

const LIVE_BASE = 'https://catholicatenews.in';
const AD_UID = 'api::advertisement-slot.advertisement-slot';
const FLASH_UID = 'api::flash-news-item.flash-news-item';
const ARTICLE_UID = 'api::article.article';

function getArg(name, fallback = null) {
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === `--${name}` && process.argv[i + 1] && !String(process.argv[i + 1]).startsWith('--')) {
      return process.argv[i + 1].trim();
    }
    const m = a.match(new RegExp(`^--${name}=(.+)$`));
    if (m) return m[1].trim();
  }
  return fallback;
}

const DRY_RUN = process.argv.includes('--dry-run');
const TENANTS_RAW =
  getArg('tenants', process.env.STRAPI_ADS_FLASH_TENANTS || '') ||
  getArg('tenant-id', process.env.TENANT_ID || '');
const TENANT_IDS = (TENANTS_RAW || 'tenant_demo_002,mosc_malankara_orthodox_2')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function fetchUrl(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'StrapiAdsFlashImport/1.0', Accept: 'text/html,*/*' } },
      (res) => {
        const code = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          res.resume();
          if (redirectCount >= 5) return reject(new Error('Too many redirects'));
          const next = new URL(res.headers.location, url).toString();
          return fetchUrl(next, redirectCount + 1).then(resolve, reject);
        }
        if (code !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${code} for ${url}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function absoluteUrl(href) {
  if (!href || typeof href !== 'string') return null;
  const t = href.trim();
  if (!t || t === '#' || t.startsWith('javascript:')) return null;
  try {
    return new URL(t, LIVE_BASE + '/').toString();
  } catch (_) {
    return null;
  }
}

function preferFullImageUrl(src) {
  if (!src) return null;
  // Prefer non-resized originals when WP serves -300x300 style thumbs
  return src.replace(/-\d+x\d+(\.[a-z0-9]+)$/i, '$1');
}

function downloadImageToTemp(imageUrl) {
  return new Promise((resolve, reject) => {
    const ext = path.extname(new URL(imageUrl).pathname) || '.jpg';
    const tempPath = path.join(os.tmpdir(), `cn-ad-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    const file = fs.createWriteStream(tempPath);
    const req = https.get(
      imageUrl,
      { headers: { 'User-Agent': 'StrapiAdsFlashImport/1.0' } },
      (res) => {
        const code = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          res.resume();
          file.close();
          try {
            fs.unlinkSync(tempPath);
          } catch (_) {}
          return downloadImageToTemp(new URL(res.headers.location, imageUrl).toString()).then(resolve, reject);
        }
        if (code !== 200) {
          res.resume();
          file.close();
          try {
            fs.unlinkSync(tempPath);
          } catch (_) {}
          return reject(new Error(`HTTP ${code}`));
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => resolve(tempPath));
        });
      }
    );
    req.on('error', (err) => {
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

async function getUploadFileDocumentId(strapi, uploaded) {
  if (!uploaded) return null;
  const docId = uploaded.documentId ?? uploaded.document_id;
  if (docId != null) return docId;
  const id = uploaded.id;
  if (id == null) return null;
  const file = await strapi.db.query('plugin::upload.file').findOne({ where: { id } });
  return file?.documentId ?? file?.document_id ?? null;
}

async function uploadOneFile(strapi, imageUrl) {
  let tempPath;
  try {
    tempPath = await downloadImageToTemp(imageUrl);
    const stats = fs.statSync(tempPath);
    const ext = path.extname(tempPath).slice(1) || 'jpg';
    const mimetype = mime.lookup(ext) || 'image/jpeg';
    const name = path.basename(tempPath, path.extname(tempPath));
    const basename = path.basename(tempPath);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const [uploaded] = await strapi.plugin('upload').service('upload').upload({
          data: { fileInfo: { name, alternativeText: name, caption: name } },
          files: { filepath: tempPath, originalFileName: basename, size: stats.size, mimetype },
        });
        const documentId = await getUploadFileDocumentId(strapi, uploaded);
        return documentId != null ? { documentId } : null;
      } catch (e) {
        if (/EBUSY|EPERM|EACCES|resource busy|locked/i.test(String(e.message)) && attempt < 3) {
          await new Promise((r) => setTimeout(r, 400 * attempt));
          continue;
        }
        throw e;
      }
    }
  } finally {
    if (tempPath) {
      try {
        fs.unlinkSync(tempPath);
      } catch (_) {}
    }
  }
  return null;
}

async function uploadImageFromUrl(strapi, imageUrl) {
  if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) return null;
  const candidates = [imageUrl];
  // If we preferred a non-resized URL, also try the sized variant path patterns aren't known;
  // when original 404s, fall back by re-adding common -300x300 for squares.
  if (!/-\d+x\d+\.[a-z0-9]+$/i.test(imageUrl)) {
    candidates.push(imageUrl.replace(/(\.[a-z0-9]+)$/i, '-300x300$1'));
    candidates.push(imageUrl.replace(/(\.[a-z0-9]+)$/i, '-728x90$1'));
  }
  for (const url of candidates) {
    try {
      const uploaded = await uploadOneFile(strapi, url);
      if (uploaded) return uploaded;
    } catch (e) {
      console.warn('  Upload try failed:', String(url).slice(0, 90), e.message);
    }
  }
  console.warn('  Upload failed for all candidates:', String(imageUrl).slice(0, 90));
  return null;
}

async function setMediaRelationViaDb(strapi, contentTypeUid, entityDocumentId, fileDocumentId, fieldName = 'media') {
  if (!entityDocumentId || !fileDocumentId) return false;
  const entityRows = await strapi.db.query(contentTypeUid).findMany({
    where: { documentId: entityDocumentId },
    select: ['id'],
  });
  const fileRow = await strapi.db.query('plugin::upload.file').findOne({
    where: { documentId: fileDocumentId },
    select: ['id'],
  });
  if (!entityRows?.length || !fileRow?.id) return false;
  const db = strapi.db.connection;
  const morphTable = 'files_related_mph';
  try {
    for (const entityRow of entityRows) {
      await db(morphTable).where({ related_id: entityRow.id, related_type: contentTypeUid, field: fieldName }).del();
      await db(morphTable).insert({
        file_id: fileRow.id,
        related_id: entityRow.id,
        related_type: contentTypeUid,
        field: fieldName,
        order: 1,
      });
    }
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Parse homepage into ad slots + flash items.
 * Mapping rule:
 *   - .top-add / header banner → top
 *   - square-ish mid-content promos: first → between_sections (bottom), rest → sidebar (sides)
 *   - if only one square: put in both between_sections and sidebar so UI positions are filled
 */
function scrapeHomepage(html) {
  const $ = cheerio.load(html);
  const ads = [];
  const seenSrc = new Set();

  function pushAd({ position, src, href, priority, width, height }) {
    const abs = absoluteUrl(preferFullImageUrl(src));
    if (!abs) return;
    const key = `${position}|${abs}`;
    if (seenSrc.has(key)) return;
    seenSrc.add(key);
    ads.push({
      position,
      src: abs,
      href: absoluteUrl(href),
      priority: priority ?? 1,
      width: Number(width) || 0,
      height: Number(height) || 0,
    });
  }

  // Top banner(s)
  $('.top-add img, .header-widget-area img').each((i, el) => {
    const $img = $(el);
    const src = $img.attr('src') || $img.attr('data-src') || '';
    if (/logo|CN-LOGO|footer|weberge/i.test(src)) return;
    const $a = $img.closest('a');
    pushAd({
      position: 'top',
      src,
      href: $a.attr('href'),
      priority: i + 1,
      width: $img.attr('width'),
      height: $img.attr('height'),
    });
  });

  // Mid-content square promos (exclude article thumbnails / logos)
  const squares = [];
  $('.article-section img, .main-article img, .element-wraper img').each((_, el) => {
    const $img = $(el);
    const src = $img.attr('src') || '';
    const cls = $img.attr('class') || '';
    if (/wp-post-image/i.test(cls)) return;
    if (/logo|footer|CN-LOGO|orthodox-logo/i.test(src + cls)) return;
    if (!/uploads\//i.test(src)) return;
    const w = Number($img.attr('width') || 0);
    const h = Number($img.attr('height') || 0);
    // Prefer square / portrait promo tiles (not wide banners)
    if (w >= 500 && h > 0 && w / h > 2.5) return;
    const $a = $img.closest('a');
    const abs = absoluteUrl(preferFullImageUrl(src));
    if (!abs) return;
    if (squares.some((s) => s.src === abs)) return;
    squares.push({
      src: abs,
      href: absoluteUrl($a.attr('href')),
      width: w,
      height: h,
    });
  });

  // Assign squares: first → between_sections (bottom), remaining → sidebar
  if (squares.length === 1) {
    pushAd({ position: 'between_sections', ...squares[0], priority: 1 });
    pushAd({ position: 'sidebar', ...squares[0], priority: 1 });
  } else {
    squares.forEach((sq, i) => {
      if (i === 0) {
        pushAd({ position: 'between_sections', ...sq, priority: 1 });
      } else {
        pushAd({ position: 'sidebar', ...sq, priority: i });
      }
    });
  }

  // Flash news carousel
  const flash = [];
  const flashSeen = new Set();
  $('.flash-news .carousel-item a, .tb-flash-carousel .carousel-item a, .flash-news a').each((i, el) => {
    const $a = $(el);
    const content = $a.text().trim().replace(/\s+/g, ' ');
    const href = absoluteUrl($a.attr('href'));
    if (!content || content.length < 3) return;
    const key = content.slice(0, 80) + '|' + (href || '');
    if (flashSeen.has(key)) return;
    flashSeen.add(key);
    flash.push({
      title: content.slice(0, 255),
      content: content.slice(0, 600),
      externalUrl: href,
      order: i + 1,
    });
  });

  return { ads, flash, squareCount: squares.length };
}

async function getTenant(strapi, tenantId) {
  const existing = await strapi.db.query('api::tenant.tenant').findOne({
    where: { tenantId },
    select: ['id', 'documentId', 'document_id'],
  });
  if (!existing) return null;
  return {
    id: existing.id,
    documentId: existing.documentId ?? existing.document_id ?? existing.id,
  };
}

function listFromDocs(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.results)) return result.results;
  if (Array.isArray(result?.data)) return result.data;
  return [];
}

const {
  getTenantJoinTable,
  ensureTenantLinkOnRow,
} = require('../src/utils/tenant-assignment');

/** Lifecycle strips tenant on script creates — link via DB after create. */
async function ensureTenantLink(strapi, uid, entityDocumentId, tenantNumericId) {
  if (!entityDocumentId || tenantNumericId == null) return 0;
  const joinTable = getTenantJoinTable(strapi, uid);
  if (!joinTable) return 0;
  const rows = await strapi.db.query(uid).findMany({
    where: { documentId: entityDocumentId },
    select: ['id'],
  });
  if (!rows?.length) return 0;
  let linked = 0;
  for (const row of rows) {
    const changed = await ensureTenantLinkOnRow(strapi, uid, row.id, tenantNumericId, joinTable);
    if (changed) linked++;
  }
  return linked;
}

async function deleteOrphanEntries(strapi, uid) {
  const knex = strapi.db.connection;
  const table = uid === AD_UID ? 'advertisement_slots' : 'flash_news_items';
  const linkTable = uid === AD_UID ? 'advertisement_slots_tenant_lnk' : 'flash_news_items_tenant_lnk';
  const entryCol = uid === AD_UID ? 'advertisement_slot_id' : 'flash_news_item_id';
  const orphans = await knex(table)
    .leftJoin(linkTable, `${linkTable}.${entryCol}`, `${table}.id`)
    .whereNull(`${linkTable}.tenant_id`)
    .distinct(`${table}.document_id as documentId`);
  const seen = new Set();
  let n = 0;
  for (const row of orphans) {
    const id = row.documentId ?? row.document_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    try {
      await strapi.documents(uid).delete({ documentId: id });
      n++;
    } catch (e) {
      console.warn('  Delete orphan skip', id, e.message);
    }
  }
  return n;
}

async function deleteTenantAds(strapi, tenantDoc) {
  const existing = await strapi.documents(AD_UID).findMany({
    filters: { tenant: { id: { $eq: tenantDoc.id } } },
    fields: ['position'],
    limit: 200,
  });
  const list = listFromDocs(existing);
  for (const row of list) {
    const docId = row.documentId ?? row.document_id;
    if (!docId) continue;
    try {
      await strapi.documents(AD_UID).delete({ documentId: docId });
    } catch (e) {
      console.warn('  Delete ad skip', docId, e.message);
    }
  }
  return list.length;
}

async function deleteTenantFlash(strapi, tenantDoc) {
  const existing = await strapi.documents(FLASH_UID).findMany({
    filters: { tenant: { id: { $eq: tenantDoc.id } } },
    fields: ['title'],
    limit: 200,
    status: 'draft',
  });
  const published = await strapi.documents(FLASH_UID).findMany({
    filters: { tenant: { id: { $eq: tenantDoc.id } } },
    fields: ['title'],
    limit: 200,
    status: 'published',
  });
  const seen = new Set();
  const list = [...listFromDocs(existing), ...listFromDocs(published)].filter((row) => {
    const id = row.documentId ?? row.document_id;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  for (const row of list) {
    const docId = row.documentId ?? row.document_id;
    if (!docId) continue;
    try {
      await strapi.documents(FLASH_UID).delete({ documentId: docId });
    } catch (e) {
      console.warn('  Delete flash skip', docId, e.message);
    }
  }
  return list.length;
}

/** Try to link flash item to a local article by matching URL path tokens to slug. */
async function findArticleForFlashUrl(strapi, tenantDoc, externalUrl) {
  if (!externalUrl) return null;
  let pathname = '';
  try {
    pathname = decodeURIComponent(new URL(externalUrl).pathname).replace(/^\/|\/$/g, '');
  } catch (_) {
    return null;
  }
  if (!pathname) return null;
  // Prefer English slug segment if present
  const candidates = [
    pathname.split('/').filter(Boolean).pop(),
    pathname,
  ]
    .filter(Boolean)
    .map((s) =>
      String(s)
        .toLowerCase()
        .replace(/[^a-z0-9-_.~]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
    )
    .filter((s) => s.length >= 4);

  for (const slug of candidates) {
    if (!/^[a-z0-9]/.test(slug)) continue;
    const found = await strapi.documents(ARTICLE_UID).findMany({
      filters: {
        slug: { $eq: slug },
        tenant: { id: { $eq: tenantDoc.id } },
      },
      fields: ['slug'],
      limit: 1,
    });
    const row = listFromDocs(found)[0];
    if (row?.documentId || row?.document_id) {
      return row.documentId ?? row.document_id;
    }
  }
  return null;
}

async function seedTenant(strapi, tenantId, scraped, mediaCache) {
  const tenantDoc = await getTenant(strapi, tenantId);
  if (!tenantDoc) {
    console.warn(`Tenant ${tenantId} not found — skip`);
    return;
  }
  console.log(`\n=== Tenant ${tenantId} (id=${tenantDoc.id}) ===`);

  if (DRY_RUN) {
    console.log('DRY RUN — would replace', scraped.ads.length, 'ads and', scraped.flash.length, 'flash items');
    return;
  }

  const deletedAds = await deleteTenantAds(strapi, tenantDoc);
  const deletedFlash = await deleteTenantFlash(strapi, tenantDoc);
  console.log(`Removed ${deletedAds} existing ad(s), ${deletedFlash} flash item(s)`);

  const startDate = new Date().toISOString();
  const endDate = new Date();
  endDate.setFullYear(endDate.getFullYear() + 2);
  const endDateIso = endDate.toISOString();
  const startDateOnly = startDate.slice(0, 10);
  const endDateOnly = endDateIso.slice(0, 10);

  // Ads
  for (const ad of scraped.ads) {
    let uploaded = mediaCache.get(ad.src);
    if (uploaded === undefined) {
      uploaded = (await uploadImageFromUrl(strapi, ad.src)) || null;
      mediaCache.set(ad.src, uploaded);
    }
    // Do not pass tenant in create — lifecycle deletes it without admin session.
    const data = {
      position: ad.position,
      priority: ad.priority,
      startDate,
      endDate: endDateIso,
    };
    const created = await strapi.documents(AD_UID).create({ data });
    const docId = created?.documentId ?? created?.document_id;
    if (docId) await ensureTenantLink(strapi, AD_UID, docId, tenantDoc.id);
    if (uploaded?.documentId && docId) {
      await setMediaRelationViaDb(strapi, AD_UID, docId, uploaded.documentId, 'media');
    }
    console.log(
      `  Ad ${ad.position}#${ad.priority}: ${path.basename(ad.src)}${uploaded ? ' [media ok]' : ' [NO MEDIA]'}${
        ad.href ? ' → ' + ad.href.slice(0, 50) : ''
      }`
    );
  }

  // Flash news
  for (const item of scraped.flash) {
    const articleDocId = await findArticleForFlashUrl(strapi, tenantDoc, item.externalUrl);
    const data = {
      title: item.title,
      content: item.content,
      order: item.order,
      startDate: startDateOnly,
      endDate: endDateOnly,
      publishedAt: new Date().toISOString(),
    };
    if (articleDocId) {
      data.article = { connect: [articleDocId] };
    } else if (item.externalUrl) {
      data.externalUrl = item.externalUrl;
    }
    const created = await strapi.documents(FLASH_UID).create({
      data,
      status: 'published',
    });
    const docId = created?.documentId ?? created?.document_id;
    if (docId) {
      await ensureTenantLink(strapi, FLASH_UID, docId, tenantDoc.id);
      if (!created?.publishedAt) {
        try {
          await strapi.documents(FLASH_UID).publish({ documentId: docId });
          await ensureTenantLink(strapi, FLASH_UID, docId, tenantDoc.id);
        } catch (_) {}
      }
    }
    console.log(
      `  Flash #${item.order}: ${item.content.slice(0, 60)}…${
        articleDocId ? ' [article]' : item.externalUrl ? ' [external]' : ''
      }`
    );
  }
}

async function main() {
  console.log('Fetching live homepage…');
  const html = await fetchUrl(LIVE_BASE + '/');
  const scraped = scrapeHomepage(html);
  console.log('Scraped ads:', scraped.ads.length, '(squares found:', scraped.squareCount + ')');
  for (const ad of scraped.ads) {
    console.log(`  - ${ad.position}#${ad.priority} ${path.basename(ad.src)}${ad.href ? ' → ' + ad.href : ''}`);
  }
  console.log('Scraped flash:', scraped.flash.length);
  scraped.flash.forEach((f) => console.log(`  - #${f.order} ${f.content.slice(0, 70)}`));

  if (!scraped.ads.length && !scraped.flash.length) {
    console.error('Nothing scraped — abort');
    process.exit(1);
  }

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  try {
    const orphanAds = await deleteOrphanEntries(app, AD_UID);
    const orphanFlash = await deleteOrphanEntries(app, FLASH_UID);
    if (orphanAds || orphanFlash) {
      console.log(`Cleared orphan entries: ${orphanAds} ads, ${orphanFlash} flash`);
    }
    const mediaCache = new Map();
    for (const tenantId of TENANT_IDS) {
      await seedTenant(app, tenantId, scraped, mediaCache);
    }
  } finally {
    await app.destroy();
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
