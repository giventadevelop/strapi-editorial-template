#!/usr/bin/env node
/**
 * Link flash-news-items → articles by title (same-domain news detail).
 * Repairs tenant on published rows via /api/migration/fix-published.
 *
 * Scope: flash-news-items ONLY. Does not create/delete articles or other content.
 *
 * Env (production — default):
 *   STRAPI_CLOUD_URL
 *   STRAPI_CLOUD_API_TOKEN
 * Local override:
 *   --local  uses STRAPI_LOCAL_URL + STRAPI_LOCAL_API_TOKEN from .env
 *
 * Usage (from strapi-editorial-template root):
 *   node scripts/link-flash-news-to-articles.mjs --tenant-id=mosc_malankara_orthodox_2 --dry-run
 *   node scripts/link-flash-news-to-articles.mjs --tenant-id=mosc_malankara_orthodox_2
 *   node scripts/link-flash-news-to-articles.mjs --local --tenant-id=mosc_malankara_orthodox_2 --dry-run
 *
 * Docs: documentation/flash_news_article_link_fix.html
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function arg(name, fallback = null) {
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === `--${name}` && process.argv[i + 1]) return process.argv[i + 1].trim();
    const m = a.match(new RegExp(`^--${name}=(.+)$`));
    if (m) return m[1].trim();
  }
  return fallback;
}

const USE_LOCAL = process.argv.includes('--local');
const DRY_RUN = process.argv.includes('--dry-run');
const TENANT_ID = arg('tenant-id', process.env.TENANT_ID || 'mosc_malankara_orthodox_2');

const BASE_URL = (
  USE_LOCAL
    ? process.env.STRAPI_LOCAL_URL || process.env.STRAPI_URL || 'http://localhost:1337'
    : process.env.STRAPI_CLOUD_URL || process.env.STRAPI_PRODUCTION_URL || process.env.STRAPI_URL || ''
).replace(/\/$/, '');

const API_TOKEN = USE_LOCAL
  ? process.env.STRAPI_LOCAL_API_TOKEN || process.env.STRAPI_API_TOKEN || ''
  : process.env.STRAPI_CLOUD_API_TOKEN || process.env.STRAPI_PRODUCTION_API_TOKEN || process.env.STRAPI_API_TOKEN || '';

if (!BASE_URL || !API_TOKEN) {
  console.error(
    USE_LOCAL
      ? 'Set STRAPI_LOCAL_URL and STRAPI_LOCAL_API_TOKEN (or use .env).'
      : 'Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN.',
  );
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${API_TOKEN}`,
  'Content-Type': 'application/json',
};

const SNAPSHOT_PATH = path.join(
  root,
  'documentation',
  'data',
  'flash-news-article-links-local-snapshot.json',
);

const norm = (s) =>
  String(s || '')
    .replace(/[\s.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

async function api(pathname, options = {}) {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text?.slice(0, 500) };
  }
  return { status: res.status, ok: res.ok, json };
}

function rows(json) {
  if (!json) return [];
  if (Array.isArray(json.data)) return json.data;
  if (json.data && typeof json.data === 'object') return [json.data];
  return [];
}

function field(obj, k) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj[k] != null) return obj[k];
  if (obj.attributes && obj.attributes[k] != null) return obj.attributes[k];
  return null;
}

function loadManualFallbacks() {
  try {
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
    const map = new Map();
    for (const item of snap.items || []) {
      if (item.matchStrategy === 'manual-fallback-same-story-as-english-russia-article' && item.articleSlug) {
        map.set(norm(item.title || item.content), item.articleSlug);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

async function listAll(collectionPath, queryBase) {
  const out = [];
  let page = 1;
  while (true) {
    const q = `${queryBase}&pagination[page]=${page}&pagination[pageSize]=100`;
    const r = await api(`${collectionPath}?${q}`);
    if (!r.ok) throw new Error(`${collectionPath} page=${page} HTTP ${r.status} ${JSON.stringify(r.json?.error || r.json)}`);
    const list = rows(r.json);
    out.push(...list);
    const pagination = r.json?.meta?.pagination;
    if (!pagination || page >= pagination.pageCount) break;
    page++;
  }
  return out;
}

async function main() {
  console.log('Flash news → article link (flash-news-items only)');
  console.log(`baseUrl=${BASE_URL}`);
  console.log(`tenantId=${TENANT_ID}`);
  console.log(`mode=${USE_LOCAL ? 'local' : 'cloud/production'}${DRY_RUN ? ' dry-run' : ''}`);

  const tenantFilter = `filters[tenant][tenantId][$eq]=${encodeURIComponent(TENANT_ID)}`;
  const flashList = await listAll(
    '/api/flash-news-items',
    `${tenantFilter}&filters[publishedAt][$notNull]=true&populate[0]=article&sort=order:asc,publishedAt:desc`,
  );
  const articleList = await listAll(
    '/api/articles',
    `${tenantFilter}&filters[publishedAt][$notNull]=true&fields[0]=title&fields[1]=slug&fields[2]=documentId&fields[3]=id`,
  );

  const articlesByDoc = new Map();
  const articlesByTitle = new Map();
  const articlesBySlug = new Map();
  for (const a of articleList) {
    const documentId = field(a, 'documentId');
    const id = field(a, 'id');
    const title = field(a, 'title');
    const slug = field(a, 'slug');
    if (!documentId || !slug) continue;
    // Cloud publish-only articles often have no draft row; Document Service
    // relation by documentId then fails with locale "null" not found.
    // Numeric entry id works for manyToOne connect on published flash rows.
    const row = { documentId, id, title, slug };
    articlesByDoc.set(documentId, row);
    if (title) articlesByTitle.set(norm(title), row);
    articlesBySlug.set(slug, row);
  }

  const manualFallbackSlugByTitle = loadManualFallbacks();
  console.log(`Flash items: ${flashList.length}; unique published articles: ${articlesByDoc.size}`);

  const plan = [];
  for (const item of flashList) {
    const documentId = field(item, 'documentId');
    const title = field(item, 'title') || field(item, 'content') || '';
    const externalUrl = field(item, 'externalUrl');
    const existingArticle = item.article || item.attributes?.article;
    const existingSlug = field(existingArticle, 'slug');
    if (existingSlug) {
      plan.push({
        flashDocumentId: documentId,
        flashTitle: title.slice(0, 80),
        status: 'already-linked',
        articleSlug: existingSlug,
        externalUrl,
      });
      continue;
    }

    const key = norm(title);
    let match = articlesByTitle.get(key) || null;
    if (!match) {
      match =
        [...articlesByTitle.entries()].find(
          ([t]) => t.startsWith(key.slice(0, 25)) || key.startsWith(t.slice(0, 25)),
        )?.[1] || null;
    }
    if (!match) {
      const fallbackSlug = manualFallbackSlugByTitle.get(key);
      if (fallbackSlug && articlesBySlug.has(fallbackSlug)) {
        match = articlesBySlug.get(fallbackSlug);
      }
    }

    plan.push({
      flashDocumentId: documentId,
      flashId: field(item, 'id'),
      flashTitle: title.slice(0, 80),
      status: match ? 'link' : 'no-match',
      articleDocumentId: match?.documentId || null,
      articleId: match?.id || null,
      articleSlug: match?.slug || null,
      externalUrl,
    });
  }

  console.log(JSON.stringify(plan, null, 2));

  const toLink = plan.filter((p) => p.status === 'link');
  const already = plan.filter((p) => p.status === 'already-linked');
  const noMatch = plan.filter((p) => p.status === 'no-match');
  console.log(`Summary: link=${toLink.length} already-linked=${already.length} no-match=${noMatch.length}`);

  if (DRY_RUN) {
    console.log('[dry-run] No Strapi updates written.');
    return;
  }

  if (toLink.length === 0) {
    console.log('Nothing to link.');
    return;
  }

  const tenantRes = await api(
    `/api/tenants?filters[tenantId][$eq]=${encodeURIComponent(TENANT_ID)}&pagination[pageSize]=1`,
  );
  if (!tenantRes.ok) throw new Error(`Tenant lookup failed HTTP ${tenantRes.status}`);
  const tenantDocumentId = field(rows(tenantRes.json)[0], 'documentId');
  if (!tenantDocumentId) {
    console.error('Could not resolve tenant documentId for', TENANT_ID);
    process.exit(1);
  }

  const linkedIds = [];
  for (const row of toLink) {
    const articleRef = row.articleId != null ? row.articleId : row.articleDocumentId;
    if (articleRef == null) {
      console.error('Failed to link', row.flashDocumentId, 'missing article id');
      continue;
    }
    const r = await api(`/api/flash-news-items/${row.flashDocumentId}?status=published`, {
      method: 'PUT',
      body: JSON.stringify({ data: { article: articleRef } }),
    });
    if (!r.ok) {
      console.error('Failed to link', row.flashDocumentId, r.status, r.json);
      continue;
    }
    linkedIds.push(row.flashDocumentId);
    console.log('Linked article', row.flashDocumentId, '→', row.articleSlug, `(id=${articleRef})`);
  }

  if (linkedIds.length) {
    // Omit publishedAt so drafts are not double-published (duplicate list rows).
    const fixRes = await api('/api/migration/fix-published', {
      method: 'POST',
      body: JSON.stringify({
        tenantDocumentId,
        articles: linkedIds.map((documentId) => ({
          documentId,
          uid: 'api::flash-news-item.flash-news-item',
        })),
      }),
    });
    console.log('Tenant repair via fix-published:', fixRes.status, JSON.stringify(fixRes.json));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
