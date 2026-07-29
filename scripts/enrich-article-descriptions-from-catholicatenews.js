'use strict';

/**
 * Enrich Editorial – Article `description` with full body text scraped from
 * https://catholicatenews.in/ article detail pages (listings only store excerpts).
 *
 * Usage:
 *   node scripts/enrich-article-descriptions-from-catholicatenews.js
 *   node scripts/enrich-article-descriptions-from-catholicatenews.js --tenants=tenant_demo_002,mosc_malankara_orthodox_2
 *   node scripts/enrich-article-descriptions-from-catholicatenews.js --dry-run
 *   node scripts/enrich-article-descriptions-from-catholicatenews.js --min-len=80 --force
 */

try {
  require('dotenv').config();
} catch (_) {}

const https = require('https');
const cheerio = require('cheerio');
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const LIVE_BASE = 'https://catholicatenews.in';
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
const FORCE = process.argv.includes('--force');
const MIN_LEN = Math.max(20, parseInt(getArg('min-len', '80'), 10) || 80);
const TENANTS_RAW =
  getArg('tenants', process.env.STRAPI_NEWS_TENANTS || '') ||
  getArg('tenant-id', process.env.TENANT_ID || '');
const TENANT_IDS = (TENANTS_RAW || 'tenant_demo_002,mosc_malankara_orthodox_2')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const CATEGORY_SLUGS = ['main-news', 'featured-news', 'press-release', 'most-read'];

function normTitle(s) {
  return String(s || '')
    .replace(/[\s.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fetchUrl(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'StrapiNewsEnrich/1.0', Accept: 'text/html,*/*' } },
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
    req.setTimeout(45000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function absUrl(href) {
  if (!href) return null;
  try {
    return new URL(href, LIVE_BASE).toString();
  } catch {
    return null;
  }
}

/** Collect title → canonical article URL from homepage + category archives. */
async function collectTitleUrlMap() {
  const byTitle = new Map();

  function ingestHtml(html) {
    const $ = cheerio.load(html);
    $('article.post .entry-title a, article[id^="post-"] .entry-title a, .article-block h3 a, .flash-news a, a[rel="bookmark"]').each((_, el) => {
      const $a = $(el);
      const title = $a.text().replace(/\s+/g, ' ').trim();
      const href = absUrl($a.attr('href'));
      if (!title || !href) return;
      if (!href.includes('catholicatenews.in')) return;
      if (/\/category\//i.test(href) || /\/page\//i.test(href)) return;
      const key = normTitle(title);
      if (!byTitle.has(key)) byTitle.set(key, { title, url: href });
    });
  }

  console.log('Scraping homepage…');
  ingestHtml(await fetchUrl(LIVE_BASE + '/'));

  for (const cat of CATEGORY_SLUGS) {
    if (cat === 'most-read') continue; // homepage section only
    for (let page = 1; page <= 6; page++) {
      const url = `${LIVE_BASE}/category/${cat}/page/${page}/`;
      try {
        console.log('  Category', cat, 'page', page);
        const html = await fetchUrl(url);
        ingestHtml(html);
        await sleep(200);
      } catch (e) {
        if (page === 1) console.warn('  Skip', cat, e.message);
        break;
      }
    }
  }

  console.log('Unique source articles by title:', byTitle.size);
  return byTitle;
}

/** Extract full article body as plain text (paragraphs joined). */
function extractFullDescription(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript, .sharedaddy, .jp-relatedposts, .post-navigation, nav, footer, .comments-area').remove();

  const selectors = [
    '.entry-content',
    '.td-post-content',
    '.post-content',
    'article .entry-content',
    '.content-inner',
    'article .post',
  ];

  let root = null;
  for (const s of selectors) {
    const el = $(s).first();
    if (el.length) {
      root = el;
      break;
    }
  }
  if (!root) return '';

  // Drop share/related chrome inside content
  root.find('.sharedaddy, .jp-relatedposts, .post-views, .td-post-sharing').remove();

  const paras = [];
  root.find('p').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (/^share this/i.test(t)) return;
    if (/^related posts/i.test(t)) return;
    paras.push(t);
  });

  if (paras.length) return paras.join('\n\n');

  const fallback = root.text().replace(/\s+/g, ' ').trim();
  return fallback;
}

function descLen(d) {
  if (d == null) return 0;
  if (typeof d === 'string') return d.trim().length;
  if (Array.isArray(d)) return JSON.stringify(d).length;
  return String(d).length;
}

async function syncDraftDescription(strapi, documentId, description) {
  const db = strapi.db.connection;
  const rows = await db('articles')
    .where({ document_id: documentId })
    .select('id', 'published_at');
  const now = new Date().toISOString();
  for (const row of rows || []) {
    await db('articles').where({ id: row.id }).update({
      description,
      updated_at: now,
    });
  }
}

async function main() {
  console.log('Enrich article descriptions from catholicatenews.in');
  console.log('  Tenants:', TENANT_IDS.join(', '));
  console.log('  Dry run:', DRY_RUN, 'Force:', FORCE, 'Min len:', MIN_LEN);

  const titleUrlMap = await collectTitleUrlMap();
  if (titleUrlMap.size === 0) {
    console.error('No source articles discovered from live site.');
    process.exit(1);
  }

  // Prefetch full bodies for all unique URLs (shared across tenants)
  console.log('\nFetching article detail pages…');
  const urls = [...new Set([...titleUrlMap.values()].map((v) => v.url))];
  const bodyByUrl = new Map();
  let fetched = 0;
  for (const url of urls) {
    try {
      const html = await fetchUrl(url);
      const body = extractFullDescription(html);
      bodyByUrl.set(url, body || '');
      fetched++;
      if (fetched % 5 === 0) console.log('  Fetched', fetched, '/', urls.length);
      await sleep(200);
    } catch (e) {
      console.warn('  Fetch fail', url.slice(0, 80), e.message);
      bodyByUrl.set(url, '');
    }
  }
  console.log('  Detail pages fetched:', fetched, 'non-empty bodies:', [...bodyByUrl.values()].filter((b) => b.length >= MIN_LEN).length);

  // Attach bodies onto title map for enrichTenant reuse via closure override
  // Re-run matching inside Strapi using bodyByUrl
  const app = await createStrapi(await compileStrapi()).load();
  app.log.level = 'error';

  const totals = { updated: 0, skipped: 0, failed: 0, noSource: 0 };
  try {
    for (const tenantId of TENANT_IDS) {
      console.log('\n=== Tenant', tenantId, '===');
      const tenant = await app.documents('api::tenant.tenant').findMany({
        filters: { tenantId: { $eq: tenantId } },
        limit: 1,
      });
      const tenantRow = Array.isArray(tenant) ? tenant[0] : tenant?.results?.[0];
      if (!tenantRow) {
        console.warn('  Tenant not found, skip');
        continue;
      }

      const articles = await app.documents(ARTICLE_UID).findMany({
        filters: { tenant: { tenantId: { $eq: tenantId } } },
        fields: ['title', 'slug', 'description', 'documentId'],
        limit: 5000,
        status: 'published',
      });
      const listRaw = Array.isArray(articles) ? articles : articles?.results || [];
      const seenDoc = new Set();
      const list = [];
      for (const art of listRaw) {
        if (!art?.documentId || seenDoc.has(art.documentId)) continue;
        seenDoc.add(art.documentId);
        list.push(art);
      }
      console.log('  Published articles:', list.length);

      for (const art of list) {
        const key = normTitle(art.title);
        let resolved = titleUrlMap.get(key);
        if (!resolved) {
          const hit = [...titleUrlMap.entries()].find(
            ([t]) => t.startsWith(key.slice(0, 28)) || key.startsWith(t.slice(0, 28))
          );
          if (hit) resolved = hit[1];
        }

        const currentLen = descLen(art.description);
        if (!resolved?.url) {
          totals.noSource++;
          console.warn('  No source URL:', (art.title || '').slice(0, 50), art.slug);
          continue;
        }

        const body = bodyByUrl.get(resolved.url) || '';
        if (!body || body.length < MIN_LEN) {
          totals.failed++;
          console.warn('  Thin/missing body:', art.slug, 'len=', body.length);
          continue;
        }

        // Skip if already has substantial content at least as long as scraped body
        // or clearly longer than a listing excerpt (>= MIN_LEN and within 10% of full)
        if (!FORCE && currentLen >= Math.min(body.length, Math.max(MIN_LEN, Math.floor(body.length * 0.85)))) {
          totals.skipped++;
          continue;
        }
        // Also skip short stubs only when force is off and body isn't longer
        if (!FORCE && currentLen > 0 && currentLen >= body.length) {
          totals.skipped++;
          continue;
        }

        console.log(
          DRY_RUN ? '  [dry-run] Would update' : '  Update',
          art.slug,
          `desc ${currentLen} → ${body.length}`
        );
        if (!DRY_RUN) {
          // Update description via knex only — Document Service PUT can wipe tenant/category.
          await syncDraftDescription(app, art.documentId, body);
        }
        totals.updated++;
      }
    }
  } finally {
    await app.destroy();
  }

  console.log('\n========== Summary ==========');
  console.log(totals);
  if (DRY_RUN) console.log('(dry-run — no DB writes)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
