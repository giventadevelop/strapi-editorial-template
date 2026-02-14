'use strict';

/**
 * News import from local clone of catholicatenews.in
 * Parses articles from category pages (main-news, featured-news, press-release, most-read).
 * Max 30 articles per category. Tenant: tenant_demo_002 (editorial).
 *
 * Config from .env: STRAPI_NEWS_CLONE_DIR (default E:\project_workspace\catholicatenews-in-temp), TENANT_ID
 * Optional: STRAPI_NEWS_FETCH_MISSING=1 to fetch missing category pages from https://catholicatenews.in/
 * Run: npm run seed:news_catholicatenews
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

const requestContext = require(path.join(__dirname, '..', 'src', 'utils', 'request-context'));

const FETCH_MISSING = process.env.STRAPI_NEWS_FETCH_MISSING === '1' || process.env.STRAPI_NEWS_FETCH_MISSING === 'true';
const LIVE_BASE = 'https://catholicatenews.in';
const DEFAULT_CLONE_DIR = process.env.STRAPI_NEWS_CLONE_DIR
  ? path.resolve(process.env.STRAPI_NEWS_CLONE_DIR)
  : path.join('E:', 'project_workspace', 'catholicatenews-in-temp');
const DEFAULT_TENANT_ID = process.env.TENANT_ID || 'tenant_demo_002';
const PER_CATEGORY_LIMIT = 30;

const CATEGORIES = [
  { slug: 'main-news', name: 'Main News', isFeatured: false },
  { slug: 'featured-news', name: 'Featured News', isFeatured: true },
  { slug: 'press-release', name: 'Press Release', isFeatured: false },
  { slug: 'most-read', name: 'Most Read', isFeatured: false },
];

/** Strapi UID pattern: [A-Za-z0-9-_.~]. Sanitize to valid slug. */
function sanitizeSlug(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .trim()
    .replace(/[^A-Za-z0-9-_.~]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function slugify(name) {
  if (!name || typeof name !== 'string') return '';
  return sanitizeSlug(
    name
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-_.~]/g, '-')
  );
}

function text($el) {
  if (!$el || !$el.length) return '';
  return $el.text().trim().replace(/\s+/g, ' ');
}

/** Extract slug from article URL. Decode and sanitize to match UID pattern [A-Za-z0-9-_.~]. */
function slugFromUrl(href) {
  if (!href || typeof href !== 'string') return '';
  try {
    const url = href.startsWith('http') ? href : LIVE_BASE + (href.startsWith('/') ? '' : '/') + href;
    const parsed = new URL(url);
    let seg = parsed.pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop() || '';
    try {
      seg = decodeURIComponent(seg);
    } catch (_) {}
    const sanitized = sanitizeSlug(seg);
    return sanitized || '';
  } catch (_) {
    return '';
  }
}

let $;

/** Parse article items from HTML. Supports both category archive (article.post) and homepage layout (.article-block). */
function parseArticlesFromHtml(html, categorySlug, htmlBaseDir) {
  if (!html) return { items: [], htmlBaseDir: htmlBaseDir || '' };
  $ = cheerio.load(html);
  const items = [];
  const seenUrls = new Set();

  let fallbackIdx = 0;
  function pushItem(title, description, imageSrc, articleUrl, publishedAt) {
    if (!title || !title.trim()) return;
    const urlKey = articleUrl || title;
    if (seenUrls.has(urlKey)) return;
    seenUrls.add(urlKey);
    let slug = slugFromUrl(articleUrl) || slugify(title);
    if (!slug) {
      slug = 'article-' + (++fallbackIdx) + '-' + Math.random().toString(36).slice(2, 10);
    }
    items.push({
      title: title.trim(),
      description: (description || '').trim().slice(0, 2048),
      imagePath: imageSrc || undefined,
      articleUrl: articleUrl || undefined,
      slug,
      publishedAt,
      categorySlug,
      htmlBaseDir,
    });
  }

  /** Extract published date from time element: prefer datetime attr, else parse visible text (e.g. "January 28, 2026").
   * Matches: time.entry-date, a[rel="bookmark"] time (from main-content), .posted-on time, .post-info time. */
  function extractPublishedAt(container) {
    const timeEl = container.find('time.entry-date, time[datetime], a[rel="bookmark"] time, .posted-on time, .post-info time').first();
    if (!timeEl.length) return null;
    let datetime = (timeEl.attr('datetime') || '').trim();
    if (datetime) {
      const d = new Date(datetime);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    const dateText = text(timeEl);
    if (dateText) {
      const d = new Date(dateText);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    return null;
  }

  // Layout 1: Category archive - article.post with .entry-img, .entry-title, .entry-content
  $('article.post, article[id^="post-"]').each((_, el) => {
    const art = $(el);
    const img = art.find('.entry-img img, .entry-img a img').first();
    const src = img.attr('src') || (img.attr('srcset') || '').split(/\s+/)[0] || '';
    const titleEl = art.find('.entry-title a').first();
    const title = text(titleEl);
    const href = titleEl.attr('href') || '';
    const publishedAt = extractPublishedAt(art);
    const descEl = art.find('.entry-content p').first();
    const description = text(descEl);
    pushItem(title, description, src, href, publishedAt);
  });

  // Layout 2: Homepage / article-section - .article-block.primary-article
  if (items.length === 0) {
    $('.article-block.primary-article, .article-block').each((_, el) => {
      const block = $(el);
      const img = block.find('.img img, img.wp-post-image').first();
      const src = img.attr('src') || (img.attr('srcset') || '').split(/\s+/)[0] || '';
      const titleEl = block.find('.content h3 a, h3 a').first();
      const title = text(titleEl);
      const href = titleEl.attr('href') || '';
      const publishedAt = extractPublishedAt(block);
      const descEl = block.find('.content p').first();
      const description = text(descEl);
      pushItem(title, description, src, href, publishedAt);
    });
  }

  return { items, htmlBaseDir: htmlBaseDir || '' };
}

function parseCategoryPage(cloneDir, categorySlug, pageNum) {
  const htmlPath = path.join(cloneDir, 'category', categorySlug, 'page', String(pageNum), 'index.html');
  if (!fs.existsSync(htmlPath)) return { items: [], htmlBaseDir: path.dirname(htmlPath) };
  const html = fs.readFileSync(htmlPath, 'utf8');
  const baseDir = path.dirname(htmlPath);
  return parseArticlesFromHtml(html, categorySlug, baseDir);
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'StrapiNewsImport/1.0' } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

async function getArticlesForCategory(cloneDir, categorySlug) {
  const all = [];
  const seenSlugs = new Set();
  let page = 1;
  for (;;) {
    let html;
    const htmlPath = path.join(cloneDir, 'category', categorySlug, 'page', String(page), 'index.html');
    if (fs.existsSync(htmlPath)) {
      html = fs.readFileSync(htmlPath, 'utf8');
    } else if (FETCH_MISSING) {
      try {
        const url = `${LIVE_BASE}/category/${categorySlug}/page/${page}/`;
        html = await fetchUrl(url);
      } catch (e) {
        break;
      }
    } else {
      break;
    }
    const baseDir = path.join(cloneDir, 'category', categorySlug, 'page', String(page));
    const { items } = parseArticlesFromHtml(html, categorySlug, baseDir);
    for (const it of items) {
      if (seenSlugs.has(it.slug)) continue;
      seenSlugs.add(it.slug);
      all.push(it);
      if (all.length >= PER_CATEGORY_LIMIT) return all.slice(0, PER_CATEGORY_LIMIT);
    }
    if (items.length === 0) break;
    page++;
  }
  return all;
}

async function collectAllArticles(cloneDir) {
  const byCategory = {};
  for (const cat of CATEGORIES) {
    const items = await getArticlesForCategory(cloneDir, cat.slug);
    byCategory[cat.slug] = items;
    console.log('  ', cat.slug + ':', items.length, 'articles');
  }
  // Deduplicate globally: an article can appear in multiple categories; assign to first category encountered
  const seen = new Map();
  const flattened = [];
  for (const cat of CATEGORIES) {
    for (const it of byCategory[cat.slug]) {
      if (seen.has(it.slug)) continue;
      seen.set(it.slug, true);
      flattened.push({ ...it, categorySlug: cat.slug, isFeatured: cat.isFeatured });
    }
  }
  return flattened;
}

async function getUploadFileDocumentId(strapi, uploaded) {
  if (!uploaded) return null;
  const docId = uploaded.documentId ?? uploaded.document_id;
  if (docId != null) return docId;
  const id = uploaded.id;
  if (id == null) return null;
  try {
    const file = await strapi.db.query('plugin::upload.file').findOne({ where: { id } });
    return file?.documentId ?? file?.document_id ?? null;
  } catch (_) {
    return null;
  }
}

function downloadImageToTemp(imageUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(imageUrl);
    const baseName = path.basename(parsed.pathname) || 'image';
    const tempPath = path.join(os.tmpdir(), `strapi-news-import-${Date.now()}-${baseName.replace(/[^a-zA-Z0-9.-]/g, '_')}`);
    const file = fs.createWriteStream(tempPath);
    const req = https.get(imageUrl, { headers: { 'User-Agent': 'StrapiNewsImport/1.0' } }, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(tempPath, () => {});
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve(tempPath));
      });
    });
    req.on('error', (err) => {
      file.close();
      try {
        fs.unlinkSync(tempPath);
      } catch (_) {}
      reject(err);
    });
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

async function uploadImageFromUrl(strapi, imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string' || !/^https:\/\//i.test(imageUrl)) return null;
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
        const isEbusalock = /EBUSY|EPERM|EACCES|resource busy|locked/i.test(String(e.message));
        if (isEbusalock && attempt < 3) {
          await new Promise((r) => setTimeout(r, 400 * attempt));
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    console.warn('  Upload image from URL failed:', imageUrl.slice(0, 80), e.message);
    return null;
  } finally {
    if (tempPath) {
      try {
        fs.unlinkSync(tempPath);
      } catch (_) {}
    }
  }
  return null;
}

async function uploadImageFromClone(strapi, cloneDir, htmlBaseDir, imagePath) {
  if (!imagePath || typeof imagePath !== 'string') return null;
  const base = typeof htmlBaseDir === 'string' && htmlBaseDir ? htmlBaseDir : cloneDir;
  const fullPath = path.resolve(String(base), String(imagePath));
  try {
    if (!fs.existsSync(fullPath)) return null;
  } catch (_) {
    return null;
  }
  const stats = fs.statSync(fullPath);
  if (!stats.isFile()) return null;
  const ext = path.extname(fullPath).slice(1) || 'jpg';
  const mimetype = mime.lookup(ext) || 'image/jpeg';
  const name = path.basename(fullPath, path.extname(fullPath));
  const basename = path.basename(fullPath);
  let tempCopy;
  try {
    tempCopy = path.join(
      os.tmpdir(),
      `strapi-news-${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${basename.replace(/[^a-zA-Z0-9.-]/g, '_')}`
    );
    fs.copyFileSync(fullPath, tempCopy);
  } catch (e) {
    console.warn('  Copy image failed:', basename, e.message);
    return null;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const [uploaded] = await strapi.plugin('upload').service('upload').upload({
        data: { fileInfo: { name, alternativeText: name, caption: name } },
        files: { filepath: tempCopy, originalFileName: basename, size: stats.size, mimetype },
      });
      const documentId = await getUploadFileDocumentId(strapi, uploaded);
      return documentId != null ? { documentId } : null;
    } catch (e) {
      const isEbusalock = /EBUSY|EPERM|EACCES|resource busy|locked/i.test(String(e.message));
      if (isEbusalock && attempt < 3) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
      console.warn('  Upload image from clone failed:', basename, e.message);
      return null;
    } finally {
      try {
        fs.unlinkSync(tempCopy);
      } catch (_) {}
    }
  }
  return null;
}

async function resolveAndUploadImage(strapi, cloneDir, htmlBaseDir, imagePath) {
  if (!imagePath || typeof imagePath !== 'string') return null;
  const trimmed = String(imagePath).trim();
  if (!trimmed) return null;
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const url = trimmed.replace(/^http:\/\//i, 'https://');
      return await uploadImageFromUrl(strapi, url);
    }
    if (trimmed.startsWith('/')) {
      return await uploadImageFromUrl(strapi, LIVE_BASE + trimmed);
    }
    let result = await uploadImageFromClone(strapi, cloneDir, htmlBaseDir, trimmed);
    if (result) return result;
    const base = typeof htmlBaseDir === 'string' && htmlBaseDir ? htmlBaseDir : cloneDir;
    const fullPath = path.resolve(String(base), trimmed);
    const relFromClone = path.relative(cloneDir, fullPath).replace(/\\/g, '/');
    const remoteUrl = LIVE_BASE + '/' + relFromClone;
    return await uploadImageFromUrl(strapi, remoteUrl);
  } catch (e) {
    console.warn('  Resolve image failed:', trimmed.slice(0, 50), e.message);
    return null;
  }
}

/**
 * Propagate category and tenant relations to ALL article rows for each document.
 * Draft rows may lack these links; the CM loads draft by default.
 */
async function syncCategoryAndTenantToAllArticleRows(strapi) {
  const db = strapi.db.connection;
  try {
    const catLinks = await db('articles_category_lnk').select('article_id', 'category_id');
    const tenantLinks = await db('articles_tenant_lnk').select('article_id', 'tenant_id');
    const byArticleId = new Map();
    for (const row of catLinks || []) {
      const art = await db('articles').where({ id: row.article_id }).select('document_id').first();
      if (art?.document_id) byArticleId.set(art.document_id, { ...(byArticleId.get(art.document_id) || {}), category_id: row.category_id });
    }
    for (const row of tenantLinks || []) {
      const art = await db('articles').where({ id: row.article_id }).select('document_id').first();
      if (art?.document_id) byArticleId.set(art.document_id, { ...(byArticleId.get(art.document_id) || {}), tenant_id: row.tenant_id });
    }
    let added = 0;
    for (const [docId, refs] of byArticleId) {
      const { category_id, tenant_id } = refs;
      if (!category_id && !tenant_id) continue;
      const allRows = await db('articles').where({ document_id: docId }).select('id');
      for (const row of allRows || []) {
        if (category_id) {
          const exists = await db('articles_category_lnk').where({ article_id: row.id }).first();
          if (!exists) {
            await db('articles_category_lnk').insert({ article_id: row.id, category_id, article_ord: 1 });
            added++;
          }
        }
        if (tenant_id) {
          const exists = await db('articles_tenant_lnk').where({ article_id: row.id }).first();
          if (!exists) {
            await db('articles_tenant_lnk').insert({ article_id: row.id, tenant_id });
            added++;
          }
        }
      }
    }
    if (added > 0) {
      console.log('  Propagated category/tenant to', added, 'additional article rows.');
    }
  } catch (err) {
    strapi.log.warn('Could not sync category/tenant:', err.message);
  }
}

/**
 * Propagate cover links to ALL article rows for each document.
 * Strapi 5 creates draft rows when the user opens an article; those rows may not have
 * the cover link. The CM loads the draft by default, so covers appear empty.
 */
async function syncCoverToAllArticleRows(strapi) {
  const db = strapi.db.connection;
  const morphTable = 'files_related_mph';
  const uid = 'api::article.article';
  try {
    const morphRows = await db(morphTable)
      .where({ related_type: uid, field: 'cover' })
      .select('related_id', 'file_id');
    const byDoc = new Map();
    for (const m of morphRows || []) {
      const art = await db('articles').where({ id: m.related_id }).select('document_id').first();
      const docId = art?.document_id;
      if (!docId) continue;
      if (!byDoc.has(docId)) byDoc.set(docId, m.file_id);
    }
    let added = 0;
    for (const [docId, fileId] of byDoc) {
      const allRows = await db('articles').where({ document_id: docId }).select('id');
      for (const row of allRows || []) {
        const existing = await db(morphTable)
          .where({ related_id: row.id, related_type: uid, field: 'cover' })
          .first();
        if (!existing) {
          await db(morphTable).insert({
            file_id: fileId,
            related_id: row.id,
            related_type: uid,
            field: 'cover',
            order: 1,
          });
          added++;
        }
      }
    }
    if (added > 0) {
      console.log('  Propagated cover to', added, 'additional article rows.');
    }
  } catch (err) {
    strapi.log.warn('Could not sync cover to all rows:', err.message);
  }
}

/**
 * Sync draft rows (published_at null) with published data.
 * Strapi 5 Content Manager list shows draft versions by default; if draft rows have empty
 * title/description/slug, the list displays dashes. Copy from published row to draft row.
 */
async function syncDraftRowsFromPublished(strapi) {
  const db = strapi.db.connection;
  try {
    const published = await db('articles')
      .select('document_id', 'title', 'description', 'slug', 'updated_at')
      .whereNotNull('published_at')
      .whereNotNull('title');
    const byDoc = new Map();
    for (const row of published || []) {
      const docId = row.document_id;
      if (!docId) continue;
      const existing = byDoc.get(docId);
      if (!existing || (row.title && !existing.title)) byDoc.set(docId, row);
    }
    let synced = 0;
    for (const [docId, pub] of byDoc) {
      const draftRows = await db('articles')
        .where({ document_id: docId })
        .whereNull('published_at');
      for (const draft of draftRows || []) {
        await db('articles').where({ id: draft.id }).update({
          title: pub.title,
          description: pub.description,
          slug: pub.slug,
          updated_at: pub.updated_at || new Date().toISOString(),
        });
        synced++;
      }
    }
    if (synced > 0) {
      console.log('  Synced', synced, 'draft rows with published data.');
    }
  } catch (err) {
    strapi.log.warn('Could not sync draft rows:', err.message);
  }
}

/** Set published_at via DB so Strapi does not overwrite with "now" on create/publish. */
async function setPublishedAtViaDb(strapi, entityDocumentId, publishedAtIso) {
  if (!entityDocumentId || !publishedAtIso || typeof publishedAtIso !== 'string') return false;
  try {
    const entityRow = await strapi.db.query('api::article.article').findOne({
      where: { documentId: entityDocumentId },
      select: ['id'],
    });
    if (!entityRow?.id) return false;
    await strapi.db.connection('articles').where({ id: entityRow.id }).update({
      published_at: publishedAtIso,
      updated_at: publishedAtIso,
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function setMediaRelationViaDb(strapi, contentTypeUid, entityDocumentId, fileDocumentId, fieldName = 'cover') {
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

async function getOrCreateTenant(strapi, tenantId) {
  const existing = await strapi.db.query('api::tenant.tenant').findOne({
    where: { tenantId },
    select: ['id', 'documentId', 'document_id'],
  });
  if (existing) {
    const documentId = existing.documentId ?? existing.document_id ?? existing.id;
    return { id: existing.id, documentId };
  }
  const created = await strapi.documents('api::tenant.tenant').create({
    data: {
      name: 'Catholicate News',
      tenantId,
      slug: tenantId,
      domain: 'catholicatenews.in',
      description: 'Catholicate News Portal',
    },
  });
  const documentId = created?.documentId ?? created?.document_id ?? created?.id;
  return { id: created?.id, documentId };
}

async function findOneAdminUserForTenant(strapi, tenantId) {
  const mappings = await strapi.db.query('api::editor-tenant.editor-tenant').findMany({
    where: {},
    populate: { tenant: true },
  });
  const mapping = mappings.find((m) => m.tenant && String(m.tenant.tenantId ?? m.tenant.id ?? '') === String(tenantId));
  const email = mapping?.adminUserEmail;
  if (!email) return null;
  const adminUser = await strapi.db.query('admin::user').findOne({
    where: { email: email.toLowerCase() },
    select: ['id', 'email'],
  });
  return adminUser ? { id: adminUser.id, email: adminUser.email } : null;
}

async function ensureCategories(strapi) {
  const map = {};
  for (const cat of CATEGORIES) {
    let existing = await strapi.db.query('api::category.category').findOne({
      where: { slug: cat.slug },
      select: ['id', 'documentId', 'document_id'],
    });
    if (!existing) {
      const created = await strapi.documents('api::category.category').create({
        data: { name: cat.name, slug: cat.slug },
      });
      existing = created;
    }
    const docId = existing?.documentId ?? existing?.document_id ?? existing?.id;
    map[cat.slug] = docId;
  }
  return map;
}

async function backfillTenantOnArticles(strapi, tenantConnectId) {
  const connectTenant = { connect: [tenantConnectId] };
  let rows = [];
  try {
    rows = await strapi.db.query('api::article.article').findMany({
      where: { tenant: null },
      select: ['id', 'documentId', 'document_id'],
    });
  } catch (_) {
    rows = await strapi.db.query('api::article.article').findMany({
      where: { tenant_id: null },
      select: ['id', 'documentId', 'document_id'],
    });
  }
  if (!rows?.length) return;
  let updated = 0;
  for (const row of rows) {
    const docId = row.documentId ?? row.document_id;
    if (docId == null) continue;
    try {
      await strapi.documents('api::article.article').update({
        documentId: docId,
        data: { tenant: connectTenant },
      });
      updated++;
    } catch (e) {
      console.warn('  Backfill skip article', docId, e.message);
    }
  }
  if (updated) console.log('  Backfilled tenant for', updated, 'articles');
}

async function runImport(strapi, cloneDir, tenantDoc) {
  const tenantConnectId = tenantDoc.documentId ?? tenantDoc.document_id ?? tenantDoc.id;
  if (tenantConnectId == null) throw new Error('Tenant has no id/documentId');
  const connectTenant = { connect: [tenantConnectId] };

  console.log('Collecting articles from category pages...');
  const articles = await collectAllArticles(cloneDir);
  if (articles.length === 0) {
    console.log('No articles found. Ensure clone exists at', cloneDir);
    return;
  }
  console.log('Total unique articles:', articles.length);

  const categoryMap = await ensureCategories(strapi);
  const ARTICLE_UID = 'api::article.article';
  const usedSlugs = new Set();

  async function createWithCoverFallback(data, coverConnect) {
    if (coverConnect) data.cover = coverConnect;
    const opts = { data, status: 'published' };
    try {
      const created = await strapi.documents(ARTICLE_UID).create(opts);
      if (created?.documentId && !created?.publishedAt) {
        try {
          await strapi.documents(ARTICLE_UID).publish({ documentId: created.documentId });
        } catch (_) {}
      }
      return created;
    } catch (e) {
      if (coverConnect) {
        delete data.cover;
        const created = await strapi.documents(ARTICLE_UID).create({ ...opts, data });
        if (created?.documentId && !created?.publishedAt) {
          try {
            await strapi.documents(ARTICLE_UID).publish({ documentId: created.documentId });
          } catch (_) {}
        }
        return created;
      }
      throw e;
    }
  }

  for (const art of articles) {
    try {
      let slug = art.slug;
      if (usedSlugs.has(slug)) {
        let suffix = 1;
        while (usedSlugs.has(slug + '-' + suffix)) suffix++;
        slug = slug + '-' + suffix;
      }
      usedSlugs.add(slug);

      const categoryDocId = categoryMap[art.categorySlug];
      if (!categoryDocId) {
        console.warn('  Skip article (no category):', art.title?.slice(0, 40));
        continue;
      }

      let coverConnect = null;
      if (art.imagePath) {
        const uploaded = await resolveAndUploadImage(strapi, cloneDir, art.htmlBaseDir, art.imagePath);
        if (uploaded) coverConnect = { connect: [{ documentId: uploaded.documentId }] };
      }

      const publishedAt = art.publishedAt && typeof art.publishedAt === 'string' ? art.publishedAt : new Date().toISOString();

      const data = {
        title: art.title,
        description: art.description,
        slug,
        category: { connect: [categoryDocId] },
        tenant: connectTenant,
        publishedAt,
        isFeatured: art.isFeatured || false,
        views: 0,
      };

      const created = await createWithCoverFallback(data, coverConnect);
      const docId = created?.documentId ?? created?.id;
      if (docId) {
        if (coverConnect) {
          const fileDocId = coverConnect?.connect?.[0]?.documentId ?? coverConnect?.connect?.[0];
          if (fileDocId) await setMediaRelationViaDb(strapi, ARTICLE_UID, docId, fileDocId, 'cover');
        }
        // Ensure published_at from source HTML is persisted (Strapi may overwrite on create)
        if (art.publishedAt && typeof art.publishedAt === 'string') {
          await setPublishedAtViaDb(strapi, docId, art.publishedAt);
        }
      }
      console.log('  Created:', art.title?.slice(0, 50));
    } catch (e) {
      console.warn('  Skip article:', art.title?.slice(0, 40), e.message);
    }
  }

  console.log('Backfilling tenant on articles...');
  await backfillTenantOnArticles(strapi, tenantConnectId);

  console.log('Syncing draft rows with published data (for Content Manager list)...');
  await syncDraftRowsFromPublished(strapi);

  console.log('Propagating cover images to all article rows (draft + published)...');
  await syncCoverToAllArticleRows(strapi);

  console.log('Propagating category and tenant to all article rows (draft + published)...');
  await syncCategoryAndTenantToAllArticleRows(strapi);

  const draftCount = await strapi.documents(ARTICLE_UID).count({ status: 'draft' });
  const publishedCount = await strapi.documents(ARTICLE_UID).count({ status: 'published' });
  console.log('Verification: draft count =', draftCount, ', published count =', publishedCount);
  if (publishedCount === 0 && draftCount > 0) {
    console.warn('  Articles are drafts only. Running bulk publish...');
    const rows = await strapi.db.query(ARTICLE_UID).findMany({
      where: { publishedAt: null },
      select: ['id'],
    });
    const db = strapi.db.connection;
    const now = new Date().toISOString();
    for (const row of rows || []) {
      try {
        await db('articles').where({ id: row.id }).update({
          published_at: now,
          updated_at: now,
        });
      } catch (_) {}
    }
    console.log('  Bulk published', (rows || []).length, 'articles via DB.');
  }

  console.log('News import finished.');
}

async function main() {
  const cloneDir = path.resolve(process.env.STRAPI_NEWS_CLONE_DIR || DEFAULT_CLONE_DIR);
  const tenantId = process.env.TENANT_ID || DEFAULT_TENANT_ID;

  if (!fs.existsSync(cloneDir)) {
    console.error('Clone directory not found:', cloneDir);
    console.error('Set STRAPI_NEWS_CLONE_DIR in .env (e.g. E:\\project_workspace\\catholicatenews-in-temp)');
    process.exit(1);
  }

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  try {
    const tenant = await getOrCreateTenant(app, tenantId);
    console.log('Tenant:', tenantId, tenant?.id ?? tenant?.documentId);
    const adminUser = await findOneAdminUserForTenant(app, tenantId);
    if (adminUser) {
      console.log('Running import as editor:', adminUser.email);
    } else {
      console.log('No editor assigned to tenant; tenant will be set via backfill.');
    }
    // Run without requestContext to avoid tenant middleware filtering; tenant is set explicitly in data + backfill
    await runImport(app, cloneDir, tenant);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await app.destroy();
  }
  process.exit(process.exitCode || 0);
}

main();
