'use strict';

/**
 * Fix duplicate article slugs on local Strapi so export and push to Cloud succeed.
 * Slugs must be unique; duplicate slugs cause "This attribute must be unique" (400) on push.
 *
 * Usage (Strapi can be running or stopped – uses REST API):
 *   set STRAPI_LOCAL_URL=http://localhost:1337
 *   set STRAPI_LOCAL_API_TOKEN=your-full-access-token
 *   node scripts/fix-duplicate-article-slugs.js
 *
 * Options:
 *   --dry-run   List duplicates and would-be new slugs, no PATCH.
 *   --content-type=api::article.article   Default; use another type that has slug if needed.
 */

try {
  require('dotenv').config();
} catch (_) {}

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ctArg = args.find(a => a.startsWith('--content-type='));
const CONTENT_TYPE_UID = ctArg ? ctArg.split('=')[1] : 'api::article.article';
const plural = 'articles'; // api::article.article -> articles

const BASE_URL = (process.env.STRAPI_LOCAL_URL || 'http://localhost:1337').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_LOCAL_API_TOKEN || '';

if (!API_TOKEN) {
  console.error('Set STRAPI_LOCAL_API_TOKEN (Full Access token from local Strapi admin).');
  process.exit(1);
}

function normalizeSlug(s) {
  if (s == null || typeof s !== 'string') return '';
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function fetchAll(baseUrl, token, pluralName) {
  const list = [];
  let page = 1;
  const pageSize = 100;
  while (true) {
    const url = `${baseUrl}/api/${pluralName}?pagination[page]=${page}&pagination[pageSize]=${pageSize}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      console.error('GET', url, res.status, await res.text());
      throw new Error(`HTTP ${res.status}`);
    }
    const json = await res.json();
    const data = json?.data;
    const items = Array.isArray(data) ? data : (data ? [data] : []);
    for (const doc of items) {
      list.push({ documentId: doc.documentId ?? doc.id, slug: doc.slug ?? '' });
    }
    if (items.length < pageSize) break;
    page++;
  }
  return list;
}

async function updateSlug(baseUrl, token, pluralName, documentId, newSlug) {
  const url = `${baseUrl}/api/${pluralName}/${documentId}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ data: { slug: newSlug } }),
  });
  return res.ok;
}

async function main() {
  console.log('Fetching all', plural, 'from', BASE_URL, '...');
  const all = await fetchAll(BASE_URL, API_TOKEN, plural);
  console.log('Total entries:', all.length);

  // Group by normalized slug
  const bySlug = new Map();
  for (const doc of all) {
    const key = normalizeSlug(doc.slug) || '(empty)';
    if (!bySlug.has(key)) bySlug.set(key, []);
    bySlug.get(key).push(doc);
  }

  const duplicates = [...bySlug.entries()].filter(([, docs]) => docs.length > 1);
  if (duplicates.length === 0) {
    console.log('No duplicate slugs found. Nothing to fix.');
    return;
  }

  console.log('Duplicate slug groups:', duplicates.length);
  let updated = 0;
  for (const [normSlug, docs] of duplicates) {
    // Keep first as-is; change 2nd, 3rd, ... to slug-2, slug-3
    const baseSlug = docs[0].slug;
    for (let i = 1; i < docs.length; i++) {
      const doc = docs[i];
      const newSlug = `${baseSlug}-${i + 1}`;
      if (DRY_RUN) {
        console.log(`  [dry-run] ${doc.documentId} "${doc.slug}" -> "${newSlug}"`);
        updated++;
        continue;
      }
      const ok = await updateSlug(BASE_URL, API_TOKEN, plural, doc.documentId, newSlug);
      if (ok) {
        console.log(`  Updated ${doc.documentId}: "${doc.slug}" -> "${newSlug}"`);
        updated++;
      } else {
        console.warn(`  Failed to update ${doc.documentId}`);
      }
    }
  }
  console.log(DRY_RUN ? `[dry-run] Would update ${updated} slugs.` : `Done. Updated ${updated} slugs.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
