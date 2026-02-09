'use strict';

/**
 * Directory import from local clone of directory.mosc.in
 * Script: data_import_seed_directory_mosc_in.js
 * Parses dioceses, bishops, priests (by diocese), directory entries, and churches (from parishes pages) from HTML.
 * Uploads images. Randomly assigns 2 priests per church (same diocese) for sample data.
 *
 * Tenant: Every imported record gets the tenant from TENANT_ID (default directory_mosc_001). This is required so
 * editor-role users (assigned to that tenant via Editor Tenant Assignment) see the data. Per multi-tenant rules,
 * tenant is set by default and not chosen in the UI.
 *
 * Config from .env: STRAPI_DATA_IMPORT_PROJECT_CLONE_DIR, TENANT_ID
 * Optional: STRAPI_DIRECTORY_FETCH_MISSING_PAGES=1 to fetch missing pages from live site: bishops, directory sections, priests, churches when not in clone.
 * Run: npm run seed:data_import_seed_directory_mosc_in
 *
 * Bishop image upload test: Run with TEST_BISHOP_UPLOAD_ONLY=1 (or npm run test:bishop_upload) to process only
 * the first 5 bishops that have an imagePath, log upload result, and verify image is linked after create.
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

const FETCH_MISSING_PAGES = process.env.STRAPI_DIRECTORY_FETCH_MISSING_PAGES === '1' || process.env.STRAPI_DIRECTORY_FETCH_MISSING_PAGES === 'true';
const LIVE_BASE = 'https://directory.mosc.in';

const DEFAULT_CLONE_DIR = process.env.STRAPI_DATA_IMPORT_PROJECT_CLONE_DIR
  ? path.resolve(process.env.STRAPI_DATA_IMPORT_PROJECT_CLONE_DIR)
  : process.env.CLONE_DIR
    ? path.resolve(process.env.CLONE_DIR)
    : path.join('E:', 'project_workspace', 'directory-mosc-in-temp');
const DEFAULT_TENANT_ID = process.env.TENANT_ID || 'directory_mosc_001';

function slugify(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

function text($el) {
  return $el.text().trim().replace(/\s+/g, ' ');
}

/** Extract email from a content-wrap (paragraph with glyphicon-envelope) */
function extractEmail($wrap) {
  const p = $wrap.find('p').filter((_, el) => $(el).find('.glyphicon-envelope').length);
  if (!p.length) return null;
  const href = $(p[0]).find('a[href^="mailto:"]').attr('href');
  if (href) return href.replace(/^mailto:/i, '').trim();
  return text($(p[0]).clone().children().remove().end()).replace(/^:\s*/, '').trim() || null;
}

/** Extract phones from content-wrap (paragraph with glyphicon-earphone); return comma-separated */
function extractPhones($wrap) {
  const p = $wrap.find('p').filter((_, el) => $(el).find('.glyphicon-earphone').length);
  if (!p.length) return null;
  const links = $(p[0]).find('a[href^="tel:"]');
  const phones = links.map((_, a) => $(a).text().trim()).get();
  if (phones.length) return phones.join(', ');
  const raw = text($(p[0]).clone().children().remove().end()).replace(/^:\s*/, '');
  return raw || null;
}

/** Extract website from content-wrap (link with glyphicon-globe or target=_blank) */
function extractWebsite($wrap) {
  const a = $wrap.find('p').has('.glyphicon-globe').find('a[target="_blank"]').first();
  if (a.length) return a.attr('href') || a.text().trim() || null;
  return null;
}

/** First paragraph that is not email/phone/website is usually address */
function extractAddress($wrap) {
  const paragraphs = $wrap.find('p');
  for (let i = 0; i < paragraphs.length; i++) {
    const p = $(paragraphs[i]);
    if (p.find('.glyphicon-envelope, .glyphicon-earphone, .glyphicon-globe').length) continue;
    const t = text(p);
    if (t && t.length > 3) return t;
  }
  return null;
}

let $;

/** Get first image src from an article. Matches live directory.mosc.in: article/img, article/figure/img, article/a/figure/img. */
function getArticleImageSrc(art) {
  const src =
    art.find('img.wp-post-image').attr('src') ||
    art.find('a figure img').attr('src') ||
    art.find('figure img').attr('src') ||
    (art.find('img').first().length ? art.find('img').first().attr('src') : null);
  return src || undefined;
}

/** Parse dioceses list HTML (live: article[1]/img; fallback article.dioceses-name). */
function parseDiocesesFromHtml(html) {
  if (!html) return [];
  $ = cheerio.load(html);
  const items = [];
  function pushDiocese(art) {
    const wrap = art.find('.content-wrap').length ? art.find('.content-wrap') : art;
    const name = text(wrap.find('h3').first());
    if (!name) return;
    const address = extractAddress(wrap);
    const email = extractEmail(wrap);
    const phones = extractPhones(wrap);
    const website = extractWebsite(wrap);
    let imgSrc = getArticleImageSrc(art);
    if (imgSrc && imgSrc.includes('dioceses-default-image')) imgSrc = undefined;
    items.push({
      name,
      slug: slugify(name),
      address: address || undefined,
      email: email || undefined,
      phones: phones || undefined,
      website: website || undefined,
      imagePath: imgSrc,
    });
  }
  $('article.dioceses-name').each((_, article) => pushDiocese($(article)));
  if (items.length === 0) {
    $('article').each((_, article) => pushDiocese($(article)));
  }
  return items;
}

function parseDioceses(cloneDir) {
  const htmlPath = path.join(cloneDir, 'dioceses', 'index.html');
  if (!fs.existsSync(htmlPath)) {
    console.warn('Dioceses list not found:', htmlPath);
    return [];
  }
  const html = fs.readFileSync(htmlPath, 'utf8');
  return parseDiocesesFromHtml(html);
}

/** Get dioceses from local clone or live site when FETCH_MISSING_PAGES and no local file. */
async function getDioceses(cloneDir) {
  const htmlPath = path.join(cloneDir, 'dioceses', 'index.html');
  if (fs.existsSync(htmlPath)) {
    const html = fs.readFileSync(htmlPath, 'utf8');
    return parseDiocesesFromHtml(html);
  }
  if (FETCH_MISSING_PAGES) {
    try {
      const html = await fetchUrl(`${LIVE_BASE}/dioceses/`);
      const items = parseDiocesesFromHtml(html);
      if (items.length) console.log('  Fetched dioceses from live site:', items.length, 'dioceses');
      return items;
    } catch (e) {
      console.warn('  Fetch dioceses failed:', e.message);
    }
  }
  return [];
}

const BISHOP_TYPE_FILE = {
  'index.html@the-holy-synod=diocesan-bishops.html': 'diocesan',
  'index.html@the-holy-synod=retired-bishops.html': 'retired',
  'index.html@the-holy-synod=the-primate.html': 'catholicos',
};

/** Live site URLs for bishops when local file is missing (STRAPI_DIRECTORY_FETCH_MISSING_PAGES=1). */
const BISHOP_TYPE_LIVE_URL = {
  'index.html@the-holy-synod=the-primate.html': `${LIVE_BASE}/bishops/?the-holy-synod=the-primate`,
  'index.html@the-holy-synod=diocesan-bishops.html': `${LIVE_BASE}/bishops/?the-holy-synod=diocesan-bishops`,
  'index.html@the-holy-synod=retired-bishops.html': `${LIVE_BASE}/bishops/?the-holy-synod=retired-bishops`,
};

/** Parse bishops list HTML (live: article/figure/img for catholicos, diocesan, retired). */
function parseBishopsFromHtml(html, bishopType) {
  if (!html) return [];
  $ = cheerio.load(html);
  const all = [];
  function pushBishop(art) {
    const wrap = art.find('.content-wrap').length ? art.find('.content-wrap') : art;
    const name = text(wrap.find('h3').first());
    if (!name) return;
    const address = extractAddress(wrap);
    const email = extractEmail(wrap);
    const phones = extractPhones(wrap);
    const img = getArticleImageSrc(art);
    all.push({
      name,
      slug: slugify(name),
      bishopType,
      address: address || undefined,
      email: email || undefined,
      phones: phones || undefined,
      order: all.length,
      imagePath: img,
    });
  }
  $('article.dioceses-name').each((_, article) => pushBishop($(article)));
  if (all.length === 0) {
    $('article').each((_, article) => pushBishop($(article)));
  }
  return all;
}

function parseBishops(cloneDir) {
  const bishopsDir = path.join(cloneDir, 'bishops');
  if (!fs.existsSync(bishopsDir)) {
    console.warn('Bishops dir not found:', bishopsDir);
    return [];
  }
  const all = [];
  for (const [filename, bishopType] of Object.entries(BISHOP_TYPE_FILE)) {
    const htmlPath = path.join(bishopsDir, filename);
    if (!fs.existsSync(htmlPath)) continue;
    const html = fs.readFileSync(htmlPath, 'utf8');
    all.push(...parseBishopsFromHtml(html, bishopType));
  }
  return all;
}

/** Get bishops from local clone and/or live site when FETCH_MISSING_PAGES is set. */
async function getBishops(cloneDir) {
  const bishopsDir = path.join(cloneDir, 'bishops');
  const all = [];
  for (const [filename, bishopType] of Object.entries(BISHOP_TYPE_FILE)) {
    const htmlPath = path.join(bishopsDir, filename);
    if (fs.existsSync(htmlPath)) {
      const html = fs.readFileSync(htmlPath, 'utf8');
      all.push(...parseBishopsFromHtml(html, bishopType));
      continue;
    }
    if (FETCH_MISSING_PAGES && BISHOP_TYPE_LIVE_URL[filename]) {
      try {
        const html = await fetchUrl(BISHOP_TYPE_LIVE_URL[filename]);
        const items = parseBishopsFromHtml(html, bishopType);
        all.push(...items);
        if (items.length) console.log('  Fetched bishops from live site:', bishopType, '-', items.length, 'entries');
      } catch (e) {
        console.warn('  Fetch bishops', bishopType, 'failed:', e.message);
      }
    }
  }
  return all;
}

const DIRECTORY_TYPE_FILE_TO_ENUM = {
  'index.html@type=directory-mosc-ininstitutions.html': 'institutions',
  'index.html@type=church-dignitaries.html': 'church-dignitaries',
  'index.html@type=working-committee.html': 'working-committee',
  'index.html@type=the-managing-committee.html': 'managing-committee',
  'index.html@type=spiritual-organisations.html': 'spiritual-organisations',
  'index.html@type=major-pilgrim-centres.html': 'pilgrim-centres',
  'index.html@type=seminaries.html': 'seminaries',
};

/** Live site URLs for directory sections when local file is missing (STRAPI_DIRECTORY_FETCH_MISSING_PAGES=1). */
const DIRECTORY_TYPE_LIVE_URL = {
  'index.html@type=directory-mosc-ininstitutions.html': `${LIVE_BASE}/directories/?type=directory-mosc-ininstitutions`,
  'index.html@type=church-dignitaries.html': `${LIVE_BASE}/directories/?type=church-dignitaries`,
  'index.html@type=working-committee.html': `${LIVE_BASE}/directories/?type=working-committee`,
  'index.html@type=the-managing-committee.html': `${LIVE_BASE}/directories/?type=the-managing-committee`,
  'index.html@type=spiritual-organisations.html': `${LIVE_BASE}/directories/?type=spiritual-organisations`,
  'index.html@type=major-pilgrim-centres.html': `${LIVE_BASE}/directories/?type=major-pilgrim-centres`,
  'index.html@type=seminaries.html': `${LIVE_BASE}/directories/?type=seminaries`,
};

/** Parse directory list HTML (live: article[1]/a/figure/img for church-dignitaries, institutions, etc.). */
function parseDirectoryEntriesFromHtml(html, directoryType) {
  if (!html) return [];
  $ = cheerio.load(html);
  const all = [];
  let order = 0;
  function pushEntry(art) {
    const wrap = art.find('.content-wrap').length ? art.find('.content-wrap') : art;
    const h3 = wrap.find('h3 a').first();
    const name = text(h3) || text(wrap.find('h3').first());
    if (!name) return;
    const address = extractAddress(wrap);
    const email = extractEmail(wrap);
    const phones = extractPhones(wrap);
    const website = extractWebsite(wrap);
    const slug = slugify(name);
    const img = getArticleImageSrc(art);
    all.push({
      name,
      slug: slug || `entry-${order}`,
      directoryType,
      address: address || undefined,
      email: email || undefined,
      phones: phones || undefined,
      website: website || undefined,
      order: order++,
      imagePath: img,
    });
  }
  $('article.directories-item').each((_, article) => pushEntry($(article)));
  if (all.length === 0) {
    $('article').each((_, article) => pushEntry($(article)));
  }
  return all;
}

function parseDirectoryEntries(cloneDir) {
  const dirDir = path.join(cloneDir, 'directories');
  if (!fs.existsSync(dirDir)) {
    console.warn('Directories dir not found:', dirDir);
    return [];
  }
  const all = [];
  let order = 0;
  for (const [filename, directoryType] of Object.entries(DIRECTORY_TYPE_FILE_TO_ENUM)) {
    const htmlPath = path.join(dirDir, filename);
    if (!fs.existsSync(htmlPath)) continue;
    const html = fs.readFileSync(htmlPath, 'utf8');
    const items = parseDirectoryEntriesFromHtml(html, directoryType);
    for (const it of items) { it.order = order++; }
    all.push(...items);
  }
  return all;
}

/** Get directory entries from local clone and/or live site when FETCH_MISSING_PAGES is set. */
async function getDirectoryEntries(cloneDir) {
  const dirDir = path.join(cloneDir, 'directories');
  const all = [];
  let order = 0;
  for (const [filename, directoryType] of Object.entries(DIRECTORY_TYPE_FILE_TO_ENUM)) {
    const htmlPath = path.join(dirDir, filename);
    let items = [];
    if (fs.existsSync(htmlPath)) {
      const html = fs.readFileSync(htmlPath, 'utf8');
      items = parseDirectoryEntriesFromHtml(html, directoryType);
    } else if (FETCH_MISSING_PAGES && DIRECTORY_TYPE_LIVE_URL[filename]) {
      try {
        const html = await fetchUrl(DIRECTORY_TYPE_LIVE_URL[filename]);
        items = parseDirectoryEntriesFromHtml(html, directoryType);
        if (items.length) console.log('  Fetched directory entries from live site:', directoryType, '-', items.length, 'entries');
      } catch (e) {
        console.warn('  Fetch directory', directoryType, 'failed:', e.message);
      }
    }
    items.forEach((it) => { it.order = order++; });
    all.push(...items);
  }
  return all;
}

/** Fetch HTML from a URL (Node https). */
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'StrapiDirectoryImport/1.0' } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/** Build map of diocese dropdown value (id) -> display name from priests.html */
function getDioceseIdToNameMap(cloneDir) {
  const htmlPath = path.join(cloneDir, 'priests.html');
  if (!fs.existsSync(htmlPath)) return new Map();
  const html = fs.readFileSync(htmlPath, 'utf8');
  $ = cheerio.load(html);
  const map = new Map();
  $('select[name="diocese"] option').each((_, el) => {
    const val = $(el).attr('value');
    const name = text($(el));
    if (val && val !== 'all' && name) map.set(val.trim(), name.trim());
  });
  return map;
}

/** Discover list-like HTML files in a folder: any file with article.dioceses-name (or similar) and "Diocese :" in content. */
function discoverListPagesInFolder(cloneDir, folderName, dioceseIdToName) {
  const found = [];
  const dir = path.join(cloneDir, folderName);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return found;
  const nameToId = new Map();
  for (const [id, name] of dioceseIdToName) nameToId.set(name.trim(), id);
  const files = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of files) {
    const fullPath = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const idx = path.join(fullPath, 'index.html');
      if (fs.existsSync(idx)) tryDiscoverFile(idx);
    } else if (ent.name.endsWith('.html')) {
      tryDiscoverFile(fullPath);
    }
  }
  function tryDiscoverFile(filePath) {
    let html;
    try { html = fs.readFileSync(filePath, 'utf8'); } catch (_) { return; }
    const $doc = cheerio.load(html);
    const count = $doc('article.dioceses-name, article.parishes-name, article.parish-item').length;
    if (count === 0) return;
    let dioceseId = null;
    const match = filePath.match(/diocese[=_]?(\d+)/i);
    if (match) dioceseId = match[1];
    if (!dioceseId) {
      const firstDiocese = $doc('p').filter((_, el) => /Diocese\s*:\s*.+/.test($doc(el).text())).first();
      const textMatch = text($doc(firstDiocese)).match(/Diocese\s*:\s*(.+)/i);
      if (textMatch) {
        const name = textMatch[1].trim();
        dioceseId = nameToId.get(name) || null;
      }
    }
    if (dioceseId) found.push({ path: filePath, dioceseId });
  }
  return found;
}

function findPriestListPages(cloneDir, dioceseIds) {
  const found = [];
  const priestsDir = path.join(cloneDir, 'priests');
  for (const id of dioceseIds) {
    const candidates = [
      path.join(priestsDir, `priests.html@diocese=${id}.html`),
      path.join(priestsDir, `index.html@diocese=${id}.html`),
      path.join(cloneDir, `priests@diocese=${id}.html`),
      path.join(cloneDir, `priests.html@diocese=${id}.html`),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        found.push({ path: p, dioceseId: id });
        break;
      }
    }
  }
  const discovered = discoverListPagesInFolder(cloneDir, 'priests', getDioceseIdToNameMap(cloneDir));
  for (const d of discovered) {
    if (!found.some((f) => f.dioceseId === d.dioceseId && f.path === d.path)) found.push(d);
  }
  return found;
}

/** Build map of diocese dropdown value (id) -> display name from parishes/index.html */
function getParishDioceseIdToNameMap(cloneDir) {
  const htmlPath = path.join(cloneDir, 'parishes', 'index.html');
  if (!fs.existsSync(htmlPath)) return new Map();
  const html = fs.readFileSync(htmlPath, 'utf8');
  $ = cheerio.load(html);
  const map = new Map();
  $('select[name="diocese"] option').each((_, el) => {
    const val = $(el).attr('value');
    const name = text($(el));
    if (val && val !== 'all' && name) map.set(val.trim(), name.trim());
  });
  return map;
}

function findParishListPages(cloneDir, dioceseIds) {
  const found = [];
  const parishesDir = path.join(cloneDir, 'parishes');
  for (const id of dioceseIds) {
    const candidates = [
      path.join(parishesDir, `parishes.html@diocese=${id}.html`),
      path.join(parishesDir, `index.html@diocese=${id}.html`),
      path.join(cloneDir, `parishes@diocese=${id}.html`),
      path.join(cloneDir, `parishes.html@diocese=${id}.html`),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        found.push({ path: p, dioceseId: id });
        break;
      }
    }
  }
  const parishMap = getParishDioceseIdToNameMap(cloneDir);
  const discovered = discoverListPagesInFolder(cloneDir, 'parishes', parishMap);
  for (const d of discovered) {
    if (!found.some((f) => f.dioceseId === d.dioceseId && f.path === d.path)) found.push(d);
  }
  return found;
}

function parseParishListPage(htmlPath, dioceseNameFromId, htmlOverride) {
  const html = htmlOverride || (htmlPath && typeof htmlPath === 'string' && fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : null);
  if (!html) return { items: [], htmlBaseDir: htmlPath && typeof htmlPath === 'string' ? path.dirname(htmlPath) : '' };
  $ = cheerio.load(html);
  const items = [];
  const dir = htmlPath && typeof htmlPath === 'string' ? path.dirname(htmlPath) : '';

  function pushChurch(art, wrap, name, address, location, dioceseName) {
    if (!name) return;
    let imgSrc = getArticleImageSrc(art);
    if (imgSrc && (imgSrc.includes('default-image') || imgSrc.includes('parish.jpg'))) imgSrc = undefined;
    items.push({
      name,
      slug: slugify(name),
      location: (location && location.length < 200) ? location : undefined,
      address: address && location !== address ? address : undefined,
      dioceseName: dioceseName || undefined,
      imagePath: imgSrc,
    });
  }

  $('article.dioceses-name, article.parishes-name, article.parish-item').each((_, article) => {
    const art = $(article);
    const wrap = art.find('.content-wrap').length ? art.find('.content-wrap') : art;
    const name = text(wrap.find('h3').first()) || text(wrap.find('h3 a').first());
    const address = extractAddress(wrap);
    const location = address || text(wrap.find('p').first());
    pushChurch(art, wrap, name, address, location, dioceseNameFromId);
  });

  if (items.length === 0) {
    $('article').each((_, article) => {
      const art = $(article);
      const wrap = art.find('.content-wrap').length ? art.find('.content-wrap') : art;
      const name = text(wrap.find('h3').first()) || text(wrap.find('h3 a').first());
      if (!name) return;
      const address = extractAddress(wrap);
      const location = address || text(wrap.find('p').first());
      pushChurch(art, wrap, name, address, location, dioceseNameFromId);
    });
  }

  return { items, htmlBaseDir: dir || '' };
}

function extractDioceseNameFromContent($wrap) {
  const paragraphs = $wrap.find('p');
  for (let i = 0; i < paragraphs.length; i++) {
    const t = text($(paragraphs[i]));
    const match = t.match(/Diocese\s*:\s*(.+)/i);
    if (match) return match[1].trim();
  }
  return null;
}

function parsePriestListPage(htmlPath, dioceseNameFromIdOrPage, htmlOverride) {
  const html = htmlOverride || (htmlPath && typeof htmlPath === 'string' && fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : null);
  if (!html) return { items: [], htmlBaseDir: htmlPath && typeof htmlPath === 'string' ? path.dirname(htmlPath) : '' };
  $ = cheerio.load(html);
  const items = [];
  const dir = htmlPath && typeof htmlPath === 'string' ? path.dirname(htmlPath) : '';

  function pushPriest(name, wrap, dioceseName, img) {
    if (!name || !name.trim()) return;
    const address = wrap ? extractAddress(wrap) : null;
    const email = wrap ? extractEmail(wrap) : null;
    const phones = wrap ? extractPhones(wrap) : null;
    items.push({
      name: name.trim(),
      slug: slugify(name),
      title: name.match(/^(Very\.?\s*Rev\.?|Fr\.?|Dn\.?|Rev\.?[^.]*)/i)?.[0]?.trim() || undefined,
      dioceseName: dioceseName || dioceseNameFromIdOrPage || undefined,
      address: address || undefined,
      email: email || undefined,
      phones: phones || undefined,
      imagePath: img || undefined,
    });
  }

  $('article.dioceses-name').each((_, article) => {
    const art = $(article);
    const wrap = art.find('.content-wrap');
    const name = text(wrap.find('h3').first());
    const dioceseName = extractDioceseNameFromContent(wrap) || dioceseNameFromIdOrPage;
    const img = getArticleImageSrc(art);
    pushPriest(name, wrap, dioceseName, img);
  });

  if (items.length === 0) {
    $('article').each((_, article) => {
      const art = $(article);
      const wrap = art.find('.content-wrap').length ? art.find('.content-wrap') : art;
      const h3 = wrap.find('h3').first();
      const name = text(h3);
      if (!name || !/Fr\.|Rev\.|Very\.?\s*Rev\.|Dn\./i.test(name)) return;
      const dioceseName = extractDioceseNameFromContent(wrap) || dioceseNameFromIdOrPage;
      const img = getArticleImageSrc(art);
      pushPriest(name, wrap, dioceseName, img);
    });
  }

  if (items.length === 0 && dioceseNameFromIdOrPage) {
    $('h3').each((_, el) => {
      const name = text($(el));
      if (!name || !/Fr\.|Rev\.|Very\.?\s*Rev\.|Dn\./i.test(name)) return;
      const parent = $(el).closest('article, .entry, .content-wrap, div[class]');
      const wrap = parent.find('.content-wrap').length ? parent.find('.content-wrap') : parent;
      const dioceseName = extractDioceseNameFromContent(wrap) || dioceseNameFromIdOrPage;
      const img = getArticleImageSrc(parent);
      pushPriest(name, wrap.length ? wrap : $(el).parent(), dioceseName, img);
    });
  }

  return { items, htmlBaseDir: dir || '' };
}

function isUploadFileRelationError(err) {
  return err && typeof err.message === 'string' && err.message.includes('plugin::upload.file') && err.message.includes('do not exist');
}

/** Resolve documentId for an uploaded file (Strapi 5 uses documentId for relations). */
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

/** Download image from a full URL (https) to a temp file and upload to Strapi. Used when source HTML is from live site. */
function downloadImageToTemp(imageUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(imageUrl);
    const baseName = path.basename(parsed.pathname) || 'image';
    const ext = path.extname(baseName).slice(1) || 'jpg';
    const tempPath = path.join(os.tmpdir(), `strapi-import-${Date.now()}-${baseName.replace(/[^a-zA-Z0-9.-]/g, '_')}`);
    const file = fs.createWriteStream(tempPath);
    const req = https.get(imageUrl, { headers: { 'User-Agent': 'StrapiDirectoryImport/1.0' } }, (res) => {
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
      try { fs.unlinkSync(tempPath); } catch (_) {}
      reject(err);
    });
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
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
    const [uploaded] = await strapi.plugin('upload').service('upload').upload({
      data: { fileInfo: { name, alternativeText: name, caption: name } },
      files: { filepath: tempPath, originalFileName: path.basename(tempPath), size: stats.size, mimetype },
    });
    const documentId = await getUploadFileDocumentId(strapi, uploaded);
    return documentId != null ? { documentId } : null;
  } catch (e) {
    console.warn('  Upload image from URL failed:', imageUrl.slice(0, 60), e.message);
    return null;
  } finally {
    if (tempPath) try { fs.unlinkSync(tempPath); } catch (_) {}
  }
}

/**
 * Upload image from a local file path (relative to htmlBaseDir) in the clone directory.
 * Used when the source HTML is from the local clone and img src is a relative path.
 * Returns null if file missing or upload fails. Never throws.
 */
async function uploadImageFromClone(strapi, cloneDir, htmlBaseDir, imagePath) {
  if (!imagePath || typeof imagePath !== 'string') return null;
  const base = typeof htmlBaseDir === 'string' && htmlBaseDir ? htmlBaseDir : cloneDir;
  const fullPath = path.resolve(String(base), String(imagePath));
  if (typeof fullPath !== 'string' || !fullPath) return null;
  try {
    if (!fs.existsSync(fullPath)) return null;
  } catch (_) {
    return null;
  }
  try {
    const stats = fs.statSync(fullPath);
    if (!stats.isFile()) return null;
    const ext = path.extname(fullPath).slice(1) || 'jpg';
    const mimetype = mime.lookup(ext) || 'image/jpeg';
    const name = path.basename(fullPath, path.extname(fullPath));
    const [uploaded] = await strapi.plugin('upload').service('upload').upload({
      data: { fileInfo: { name, alternativeText: name, caption: name } },
      files: { filepath: fullPath, originalFileName: path.basename(fullPath), size: stats.size, mimetype },
    });
    const documentId = await getUploadFileDocumentId(strapi, uploaded);
    return documentId != null ? { documentId } : null;
  } catch (e) {
    console.warn('  Upload image from clone failed:', fullPath.slice(-60), e.message);
    return null;
  }
}

/**
 * Resolve and upload image for an entity: from local clone path or from full URL (e.g. when page was fetched from live site).
 * When local path is missing, tries remote LIVE_BASE URL only for relative paths (never double-prefix http(s) URLs).
 * Never throws – returns null on any error so entity creation is not skipped.
 */
async function resolveAndUploadImage(strapi, cloneDir, htmlBaseDir, imagePath) {
  if (!imagePath || typeof imagePath !== 'string') return null;
  const trimmed = String(imagePath).trim();
  if (!trimmed) return null;
  try {
    // Absolute URLs: use as-is (avoid double-prefixing e.g. https://directory.mosc.in/http://...)
    if (/^https?:\/\//i.test(trimmed)) {
      const url = trimmed.replace(/^http:\/\//i, 'https://');
      return await uploadImageFromUrl(strapi, url);
    }
    if (trimmed.startsWith('/')) {
      return await uploadImageFromUrl(strapi, LIVE_BASE + trimmed);
    }
    // Local relative path: try clone first, then remote fallback (only build LIVE_BASE + path for relative paths)
    let result = await uploadImageFromClone(strapi, cloneDir, htmlBaseDir, trimmed);
    if (result) return result;
    const remoteUrl = LIVE_BASE + '/' + trimmed.replace(/^\/+/, '');
    return await uploadImageFromUrl(strapi, remoteUrl);
  } catch (e) {
    console.warn('  Resolve image failed:', trimmed.slice(0, 50), e.message);
    return null;
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
      name: 'Directory MOSC',
      tenantId,
      slug: tenantId,
      domain: 'directory.mosc.in',
      description: 'Malankara Orthodox Directory',
    },
  });
  const documentId = created?.documentId ?? created?.document_id ?? created?.id;
  return { id: created?.id, documentId };
}

/**
 * Find one admin user assigned to the given tenant (via Editor Tenant mapping).
 * Returns { id, email } or null. Used to run import inside request context so lifecycles set tenant on create.
 */
async function findOneAdminUserForTenant(strapi, tenantId) {
  const mappings = await strapi.db.query('api::editor-tenant.editor-tenant').findMany({
    where: {},
    populate: { tenant: true },
  });
  const mapping = mappings.find(
    (m) => m.tenant && String(m.tenant.tenantId ?? m.tenant.id ?? '') === String(tenantId)
  );
  const email = mapping?.adminUserEmail;
  if (!email) return null;
  const adminUser = await strapi.db.query('admin::user').findOne({
    where: { email: email.toLowerCase() },
    select: ['id', 'email'],
  });
  return adminUser ? { id: adminUser.id, email: adminUser.email } : null;
}

/** Backfill tenant on existing directory records that have no tenant (so editors see them). */
async function backfillTenantOnExistingRecords(strapi, tenantConnectId) {
  const directoryTypes = [
    { uid: 'api::bishop.bishop', label: 'bishops' },
    { uid: 'api::catholicos.catholicos', label: 'catholicos' },
    { uid: 'api::diocesan-bishop.diocesan-bishop', label: 'diocesan bishops' },
    { uid: 'api::retired-bishop.retired-bishop', label: 'retired bishops' },
    { uid: 'api::diocese.diocese', label: 'dioceses' },
    { uid: 'api::church.church', label: 'churches' },
    { uid: 'api::parish.parish', label: 'parishes' },
    { uid: 'api::priest.priest', label: 'priests' },
    { uid: 'api::directory-entry.directory-entry', label: 'directory entries' },
    { uid: 'api::institution.institution', label: 'institutions' },
    { uid: 'api::church-dignitary.church-dignitary', label: 'church dignitaries' },
    { uid: 'api::working-committee.working-committee', label: 'working committee' },
    { uid: 'api::managing-committee.managing-committee', label: 'managing committee' },
    { uid: 'api::spiritual-organisation.spiritual-organisation', label: 'spiritual organisations' },
    { uid: 'api::pilgrim-centre.pilgrim-centre', label: 'pilgrim centres' },
    { uid: 'api::seminary.seminary', label: 'seminaries' },
  ];
  const connectTenant = { connect: [tenantConnectId] };
  for (const { uid, label } of directoryTypes) {
    try {
      let rows = [];
      try {
        rows = await strapi.db.query(uid).findMany({
          where: { tenant: null },
          select: ['id', 'documentId', 'document_id'],
        });
      } catch (_) {
        rows = await strapi.db.query(uid).findMany({
          where: { tenant_id: null },
          select: ['id', 'documentId', 'document_id'],
        });
      }
      if (!rows?.length) continue;
      let updated = 0;
      for (const row of rows) {
        const docId = row.documentId ?? row.document_id;
        if (docId == null) continue;
        try {
          await strapi.documents(uid).update({
            documentId: docId,
            data: { tenant: connectTenant },
          });
          updated++;
        } catch (e) {
          console.warn('  Backfill skip', label, docId, e.message);
        }
      }
      if (updated) console.log('  Backfilled tenant for', updated, label);
    } catch (e) {
      console.warn('  Backfill', label, 'failed:', e.message);
    }
  }
}

async function runImport(strapi, cloneDir, tenantDoc) {
  // Strapi 5 document service expects documentId for relation connect; fallback to id for older data.
  const tenantConnectId = tenantDoc.documentId ?? tenantDoc.document_id ?? tenantDoc.id;
  if (tenantConnectId == null) {
    throw new Error('Tenant has no id/documentId');
  }
  const connectTenant = { connect: [tenantConnectId] };

  console.log('Backfilling tenant on existing directory records (if any)...');
  await backfillTenantOnExistingRecords(strapi, tenantConnectId);

  console.log('Parsing dioceses (local + remote when FETCH_MISSING_PAGES=1)...');
  const dioceses = await getDioceses(cloneDir);
  console.log('Parsing bishops (local + remote when FETCH_MISSING_PAGES=1)...');
  const bishops = await getBishops(cloneDir);
  console.log('Parsing directory entries (local + remote when FETCH_MISSING_PAGES=1)...');
  const directoryEntries = await getDirectoryEntries(cloneDir);
  const dioceseIdToName = getDioceseIdToNameMap(cloneDir);
  const parishDioceseIdToName = getParishDioceseIdToNameMap(cloneDir);
  // Use parish diocese map for priests when priests.html is missing (e.g. clone has parishes but no priests)
  const priestDioceseIds = dioceseIdToName.size > 0 ? dioceseIdToName : parishDioceseIdToName;
  const priestDioceseIdToName = dioceseIdToName.size > 0 ? dioceseIdToName : parishDioceseIdToName;
  const priestListPages = findPriestListPages(cloneDir, [...priestDioceseIds.keys()]);
  const allPriests = [];
  for (const { path: pagePath, dioceseId } of priestListPages) {
    const dioceseName = priestDioceseIdToName.get(dioceseId);
    const { items, htmlBaseDir } = parsePriestListPage(pagePath, dioceseName);
    const baseDir = htmlBaseDir || path.join(cloneDir, 'priests');
    for (const p of items) allPriests.push({ ...p, htmlBaseDir: baseDir });
  }
  if (FETCH_MISSING_PAGES) {
    for (const id of priestDioceseIds.keys()) {
      if (priestListPages.some((p) => p.dioceseId === id)) continue;
      try {
        const html = await fetchUrl(`${LIVE_BASE}/priests/?diocese=${id}`);
        const dioceseName = priestDioceseIdToName.get(id);
        const { items } = parsePriestListPage(null, dioceseName, html);
        const baseDir = path.join(cloneDir, 'priests');
        for (const p of items) allPriests.push({ ...p, htmlBaseDir: baseDir });
        if (items.length) console.log('  Fetched priests for diocese', id, '-', items.length, 'priests');
      } catch (e) {
        console.warn('  Fetch priests for diocese', id, 'failed:', e.message);
      }
    }
  }
  const parishListPages = findParishListPages(cloneDir, [...parishDioceseIdToName.keys()]);
  const allChurches = [];
  for (const { path: pagePath, dioceseId } of parishListPages) {
    const dioceseName = parishDioceseIdToName.get(dioceseId);
    const { items, htmlBaseDir } = parseParishListPage(pagePath, dioceseName);
    const baseDir = htmlBaseDir || path.join(cloneDir, 'parishes');
    for (const c of items) allChurches.push({ ...c, htmlBaseDir: baseDir });
  }
  if (FETCH_MISSING_PAGES) {
    for (const id of parishDioceseIdToName.keys()) {
      if (parishListPages.some((p) => p.dioceseId === id)) continue;
      try {
        const html = await fetchUrl(`${LIVE_BASE}/parishes/?diocese=${id}`);
        const dioceseName = parishDioceseIdToName.get(id);
        const { items } = parseParishListPage(null, dioceseName, html);
        const baseDir = path.join(cloneDir, 'parishes');
        for (const c of items) allChurches.push({ ...c, htmlBaseDir: baseDir });
        if (items.length) console.log('  Fetched churches for diocese', id, '-', items.length, 'churches');
      } catch (e) {
        console.warn('  Fetch parishes for diocese', id, 'failed:', e.message);
      }
    }
  }

  console.log(`Found ${dioceses.length} dioceses, ${bishops.length} bishops, ${directoryEntries.length} directory entries, ${allPriests.length} priests, ${allChurches.length} churches.`);
  if (allPriests.length === 0 && priestDioceseIds.size > 0) {
    console.log('  Hint: 0 priests – add priest list pages under priests/ or set STRAPI_DIRECTORY_FETCH_MISSING_PAGES=1 to fetch from the live site.');
  }
  if (allChurches.length === 0 && parishDioceseIdToName.size > 0) {
    console.log('  Hint: 0 churches – add parish list pages under parishes/ or set STRAPI_DIRECTORY_FETCH_MISSING_PAGES=1 to fetch from the live site.');
  }

  const dioceseBySlug = {};
  const priestsByDioceseSlug = {};
  const diocesesBaseDir = path.join(cloneDir, 'dioceses');
  const bishopsBaseDir = path.join(cloneDir, 'bishops');
  const directoriesBaseDir = path.join(cloneDir, 'directories');
  const testBishopUploadOnly = process.env.TEST_BISHOP_UPLOAD_ONLY === '1' || process.env.TEST_BISHOP_UPLOAD_ONLY === 'true';

  async function createWithImageFallback(apiUid, data, imageConnect, logName) {
    if (imageConnect) data.image = imageConnect;
    try {
      return await strapi.documents(apiUid).create({ data });
    } catch (e) {
      // If create failed and we had an image, retry without image so we don't skip the entity (e.g. "2 errors" or upload relation issue)
      if (imageConnect) {
        delete data.image;
        try {
          return await strapi.documents(apiUid).create({ data });
        } catch (e2) {
          throw e2;
        }
      }
      throw e;
    }
  }

  /**
   * Link a media file to a document via DB (files_related_mph). Use when Document Service
   * rejects media relation with "Invalid relations". Works for any content type with an image field.
   */
  async function setMediaRelationViaDb(strapi, contentTypeUid, entityDocumentId, fileDocumentId, fieldName = 'image') {
    if (!entityDocumentId || !fileDocumentId) return false;
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
    try {
      await db(morphTable).where({ related_id: entityRow.id, related_type: contentTypeUid, field: fieldName }).del();
      await db(morphTable).insert({
        file_id: fileRow.id,
        related_id: entityRow.id,
        related_type: contentTypeUid,
        field: fieldName,
        order: 1,
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Bishop-specific alias for test path (update existing). */
  async function setBishopImageViaDb(strapi, bishopDocumentId, uploadFileDocumentId) {
    return setMediaRelationViaDb(strapi, 'api::bishop.bishop', bishopDocumentId, uploadFileDocumentId, 'image');
  }

  if (!testBishopUploadOnly) {
    for (const d of dioceses) {
      try {
        let imageConnect = null;
        if (d.imagePath) {
          try {
            const uploaded = await resolveAndUploadImage(strapi, cloneDir, diocesesBaseDir, d.imagePath);
            if (uploaded) imageConnect = { connect: [{ documentId: uploaded.documentId }] };
          } catch (_) { /* proceed without image */ }
        }
        const data = {
          name: d.name,
          slug: d.slug,
          address: d.address,
          email: d.email,
          phones: d.phones,
          website: d.website,
          tenant: connectTenant,
        };
        const created = await createWithImageFallback('api::diocese.diocese', data, imageConnect, d.name);
        dioceseBySlug[d.slug] = created.documentId ?? created.id;
        if (imageConnect && created) {
          const fileDocId = imageConnect?.connect?.[0]?.documentId ?? imageConnect?.connect?.[0];
          if (fileDocId) await setMediaRelationViaDb(strapi, 'api::diocese.diocese', created.documentId ?? created.id, fileDocId, 'image');
        }
        console.log('  Created diocese:', d.name);
      } catch (e) {
        console.warn('  Skip diocese', d.name, e.message);
      }
    }
  }

  const BISHOP_TYPE_TO_UID = {
    catholicos: 'api::catholicos.catholicos',
    diocesan: 'api::diocesan-bishop.diocesan-bishop',
    retired: 'api::retired-bishop.retired-bishop',
  };
  const bishopsToProcess = testBishopUploadOnly ? bishops.filter((b) => b.imagePath).slice(0, 5) : bishops;
  if (testBishopUploadOnly) {
    console.log('[TEST_BISHOP_UPLOAD_ONLY] Processing', bishopsToProcess.length, 'bishops with imagePath (upload + verify).');
  }

  for (const b of bishopsToProcess) {
    try {
      let imageConnect = null;
      if (b.imagePath) {
        if (testBishopUploadOnly) console.log('  [TEST] Bishop:', b.name, '| imagePath:', b.imagePath);
        try {
          const uploaded = await resolveAndUploadImage(strapi, cloneDir, bishopsBaseDir, b.imagePath);
          if (uploaded) {
            imageConnect = { connect: [{ documentId: uploaded.documentId }] };
            if (testBishopUploadOnly) console.log('  [TEST] Upload OK -> documentId:', uploaded.documentId);
          } else {
            if (testBishopUploadOnly) console.log('  [TEST] Upload returned null (file missing or upload failed).');
          }
        } catch (err) {
          if (testBishopUploadOnly) console.warn('  [TEST] Upload error:', err.message);
          /* proceed without image */
        }
      }
      const data = {
        name: b.name,
        slug: b.slug,
        bishopType: b.bishopType,
        address: b.address,
        email: b.email,
        phones: b.phones,
        order: b.order,
        tenant: connectTenant,
      };
      let createdDocId = null;
      try {
        const created = await createWithImageFallback('api::bishop.bishop', data, imageConnect, b.name);
        createdDocId = created?.documentId ?? created?.id;
        if (created && imageConnect) {
          const fileDocId = imageConnect?.connect?.[0]?.documentId ?? imageConnect?.connect?.[0];
          if (fileDocId) await setMediaRelationViaDb(strapi, 'api::bishop.bishop', createdDocId, fileDocId, 'image');
        }
      } catch (createErr) {
        if (testBishopUploadOnly && imageConnect && /unique|already exists/i.test(createErr.message)) {
          const existing = await strapi.documents('api::bishop.bishop').findFirst({
            filters: { slug: b.slug },
            fields: ['documentId'],
          });
          if (existing?.documentId) {
            createdDocId = existing.documentId;
            const docId = imageConnect?.connect?.[0]?.documentId ?? imageConnect?.connect?.[0];
            let updated = false;
            try {
              await strapi.documents('api::bishop.bishop').update({
                documentId: existing.documentId,
                data: { image: docId },
              });
              updated = true;
              console.log('  [TEST] Bishop already exists; updated image (scalar documentId) on documentId:', createdDocId);
            } catch (e1) {
              try {
                await strapi.documents('api::bishop.bishop').update({
                  documentId: existing.documentId,
                  data: { image: { set: docId ? [docId] : [] } },
                });
                updated = true;
                console.log('  [TEST] Bishop already exists; updated image (set) on documentId:', createdDocId);
              } catch (e2) {
                if (docId && setBishopImageViaDb(strapi, existing.documentId, docId)) {
                  updated = true;
                  console.log('  [TEST] Bishop already exists; linked image via DB on documentId:', createdDocId);
                } else {
                  console.warn('  [TEST] Update image failed:', e1.message, '| fallback:', e2.message);
                }
              }
            }
          } else {
            console.warn('  Skip bishop', b.name, createErr.message);
          }
        } else {
          throw createErr;
        }
      }
      if (testBishopUploadOnly && createdDocId) {
        const withImage = await strapi.documents('api::bishop.bishop').findOne({
          documentId: createdDocId,
          populate: ['image'],
        });
        const hasImage = withImage?.image != null;
        console.log('  [TEST] Bishop documentId:', createdDocId, '| image linked:', hasImage, hasImage ? `| image.documentId: ${withImage.image?.documentId ?? withImage.image?.id}` : '');
      }
      if (!testBishopUploadOnly && createdDocId) console.log('  Created bishop:', b.name);
      const subUid = BISHOP_TYPE_TO_UID[b.bishopType];
      if (subUid) {
        const subData = {
          name: b.name,
          slug: b.slug,
          address: b.address,
          email: b.email,
          phones: b.phones,
          order: b.order,
          tenant: connectTenant,
        };
        try {
          const subCreated = await createWithImageFallback(subUid, subData, imageConnect, b.name);
          if (subCreated && imageConnect) {
            const fileDocId = imageConnect?.connect?.[0]?.documentId ?? imageConnect?.connect?.[0];
            if (fileDocId) await setMediaRelationViaDb(strapi, subUid, subCreated.documentId ?? subCreated.id, fileDocId, 'image');
          }
          if (!testBishopUploadOnly) console.log('  Created bishop subcategory:', b.name, b.bishopType);
        } catch (subErr) {
          console.warn('  Skip bishop subcategory', b.name, subErr.message);
        }
      }
    } catch (e) {
      console.warn('  Skip bishop', b.name, e.message);
    }
  }

  if (testBishopUploadOnly) {
    console.log('[TEST_BISHOP_UPLOAD_ONLY] Done. Check lines above: Upload OK -> documentId and image linked: true mean success.');
    return;
  }

  const DIRECTORY_TYPE_TO_UID = {
    institutions: 'api::institution.institution',
    'church-dignitaries': 'api::church-dignitary.church-dignitary',
    'working-committee': 'api::working-committee.working-committee',
    'managing-committee': 'api::managing-committee.managing-committee',
    'spiritual-organisations': 'api::spiritual-organisation.spiritual-organisation',
    'pilgrim-centres': 'api::pilgrim-centre.pilgrim-centre',
    seminaries: 'api::seminary.seminary',
  };
  for (const e of directoryEntries) {
    try {
      let imageConnect = null;
      if (e.imagePath) {
        try {
          const uploaded = await resolveAndUploadImage(strapi, cloneDir, directoriesBaseDir, e.imagePath);
          if (uploaded) imageConnect = { connect: [{ documentId: uploaded.documentId }] };
        } catch (_) { /* proceed without image */ }
      }
      const data = {
        name: e.name,
        slug: e.slug,
        directoryType: e.directoryType,
        address: e.address,
        email: e.email,
        phones: e.phones,
        website: e.website,
        order: e.order,
        tenant: connectTenant,
      };
      const createdEntry = await createWithImageFallback('api::directory-entry.directory-entry', data, imageConnect, e.name);
      if (createdEntry && imageConnect) {
        const fileDocId = imageConnect?.connect?.[0]?.documentId ?? imageConnect?.connect?.[0];
        if (fileDocId) await setMediaRelationViaDb(strapi, 'api::directory-entry.directory-entry', createdEntry.documentId ?? createdEntry.id, fileDocId, 'image');
      }
      console.log('  Created directory entry:', e.name, `(${e.directoryType})`);
      const sectionUid = DIRECTORY_TYPE_TO_UID[e.directoryType];
      if (sectionUid) {
        const sectionData = {
          name: e.name,
          slug: e.slug,
          address: e.address,
          email: e.email,
          phones: e.phones,
          website: e.website,
          order: e.order,
          tenant: connectTenant,
        };
        try {
          const sectionCreated = await createWithImageFallback(sectionUid, sectionData, imageConnect, e.name);
          if (sectionCreated && imageConnect) {
            const fileDocId = imageConnect?.connect?.[0]?.documentId ?? imageConnect?.connect?.[0];
            if (fileDocId) await setMediaRelationViaDb(strapi, sectionUid, sectionCreated.documentId ?? sectionCreated.id, fileDocId, 'image');
          }
          console.log('  Created directory section:', e.name, e.directoryType);
        } catch (sectionErr) {
          console.warn('  Skip directory section', e.name, sectionErr.message);
        }
      }
    } catch (err) {
      console.warn('  Skip directory entry', e.name, err.message);
    }
  }

  for (const p of allPriests) {
    try {
      const dioceseSlug = p.dioceseName ? slugify(p.dioceseName) : null;
      const dioceseDocId = dioceseSlug ? dioceseBySlug[dioceseSlug] : null;
      if (!dioceseDocId) {
        console.warn('  Skip priest (no matching diocese):', p.name, p.dioceseName);
        continue;
      }
      let imageConnect = null;
      if (p.imagePath) {
        try {
          const uploaded = await resolveAndUploadImage(strapi, cloneDir, p.htmlBaseDir, p.imagePath);
          if (uploaded) imageConnect = { connect: [{ documentId: uploaded.documentId }] };
        } catch (_) { /* proceed without image */ }
      }
      const data = {
        name: p.name,
        slug: p.slug,
        title: p.title,
        diocese: { connect: [dioceseDocId] },
        address: p.address,
        email: p.email,
        phones: p.phones,
        tenant: connectTenant,
      };
      const created = await createWithImageFallback('api::priest.priest', data, imageConnect, p.name);
      const docId = created?.documentId ?? created?.id;
      if (created && imageConnect) {
        const fileDocId = imageConnect?.connect?.[0]?.documentId ?? imageConnect?.connect?.[0];
        if (fileDocId) await setMediaRelationViaDb(strapi, 'api::priest.priest', docId, fileDocId, 'image');
      }
      if (docId && dioceseSlug) {
        if (!priestsByDioceseSlug[dioceseSlug]) priestsByDioceseSlug[dioceseSlug] = [];
        priestsByDioceseSlug[dioceseSlug].push(docId);
      }
      console.log('  Created priest:', p.name);
    } catch (err) {
      console.warn('  Skip priest', p.name, err.message);
    }
  }

  const assignedPriestIds = new Set();
  const shuffle = (arr) => arr.slice().sort(() => Math.random() - 0.5);
  for (const c of allChurches) {
    try {
      const dioceseSlug = c.dioceseName ? slugify(c.dioceseName) : null;
      const dioceseDocId = dioceseSlug ? dioceseBySlug[dioceseSlug] : null;
      if (!dioceseDocId) {
        console.warn('  Skip church (no matching diocese):', c.name, c.dioceseName);
        continue;
      }
      let imageConnect = null;
      if (c.imagePath) {
        try {
          const uploaded = await resolveAndUploadImage(strapi, cloneDir, c.htmlBaseDir, c.imagePath);
          if (uploaded) imageConnect = { connect: [{ documentId: uploaded.documentId }] };
        } catch (_) { /* proceed without image */ }
      }
      const data = {
        name: c.name,
        slug: c.slug,
        location: c.location,
        address: c.address,
        diocese: { connect: [dioceseDocId] },
        tenant: connectTenant,
      };
      const created = await createWithImageFallback('api::church.church', data, imageConnect, c.name);
      const churchDocId = created?.documentId ?? created?.id;
      if (created && imageConnect) {
        const fileDocId = imageConnect?.connect?.[0]?.documentId ?? imageConnect?.connect?.[0];
        if (fileDocId) await setMediaRelationViaDb(strapi, 'api::church.church', churchDocId, fileDocId, 'image');
      }
      if (!churchDocId) continue;
      const unassigned = (priestsByDioceseSlug[dioceseSlug] || []).filter((id) => !assignedPriestIds.has(id));
      const pick = shuffle(unassigned).slice(0, 2);
      for (const priestDocId of pick) {
        try {
          await strapi.documents('api::priest.priest').update({
            documentId: priestDocId,
            data: { church: { connect: [churchDocId] } },
          });
          assignedPriestIds.add(priestDocId);
        } catch (_) {}
      }
      try {
        const parishSlug = c.slug + '-' + dioceseSlug;
        await strapi.documents('api::parish.parish').create({
          data: {
            name: c.name,
            slug: parishSlug,
            diocese: { connect: [dioceseDocId] },
            address: c.address || c.location,
            tenant: connectTenant,
          },
        });
      } catch (parishErr) {
        console.warn('  Skip parish', c.name, parishErr.message);
      }
      console.log('  Created church:', c.name, pick.length, 'priests assigned');
    } catch (err) {
      console.warn('  Skip church', c.name, err.message);
    }
  }

  // Ensure every directory record has the tenant set (lifecycles may strip it when import runs without request context)
  console.log('Assigning tenant to all directory records...');
  await backfillTenantOnExistingRecords(strapi, tenantConnectId);

  console.log('Directory import finished.');
}

async function main() {
  const cloneDir = path.resolve(process.env.STRAPI_DATA_IMPORT_PROJECT_CLONE_DIR || process.env.CLONE_DIR || DEFAULT_CLONE_DIR);
  const tenantId = process.env.TENANT_ID || DEFAULT_TENANT_ID;

  if (!fs.existsSync(cloneDir)) {
    console.error('Clone directory not found:', cloneDir);
    console.error('Set STRAPI_DATA_IMPORT_PROJECT_CLONE_DIR (or CLONE_DIR) in .env or environment (e.g. E:\\project_workspace\\directory-mosc-in-temp)');
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
      console.log('Running import as editor:', adminUser.email, '(tenant will be set by lifecycles)');
      await requestContext.run({ state: { user: adminUser } }, () => runImport(app, cloneDir, tenant));
    } else {
      console.log('No editor assigned to this tenant; import will set tenant via backfill at the end.');
      await runImport(app, cloneDir, tenant);
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await app.destroy();
  }
  process.exit(process.exitCode || 0);
}

main();
