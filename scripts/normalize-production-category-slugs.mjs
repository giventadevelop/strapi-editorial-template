#!/usr/bin/env node

/**
 * Normalize category slugs on Strapi Cloud to lowercase kebab-case (frontend expects main-news, etc.).
 *
 * Usage:
 *   node scripts/normalize-production-category-slugs.mjs
 *   node scripts/normalize-production-category-slugs.mjs --dry-run
 */

import 'dotenv/config';

const BASE_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';

const SLUG_MAP = {
  'main-news': 'main-news',
  'Main-News': 'main-news',
  'featured-news': 'featured-news',
  'Featured-News': 'featured-news',
  'press-release': 'press-release',
  'Press-Release': 'press-release',
  'most-read': 'most-read',
  'Most-Read': 'most-read',
};

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

const DRY_RUN = process.argv.includes('--dry-run');

if (!BASE_URL || !API_TOKEN) {
  console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN.');
  process.exit(1);
}

async function api(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
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
  if (obj.attributes?.[k] != null) return obj.attributes[k];
  return null;
}

async function listCategories() {
  const out = [];
  let page = 1;
  while (true) {
    const r = await api(`/api/categories?pagination[page]=${page}&pagination[pageSize]=100`);
    if (!r.ok) throw new Error(`List categories failed HTTP ${r.status}`);
    const batch = rows(r.json);
    if (!batch.length) break;
    out.push(...batch);
    const pageCount = r.json?.meta?.pagination?.pageCount ?? 1;
    if (page >= pageCount) break;
    page++;
  }
  return out;
}

async function main() {
  const categories = await listCategories();
  console.log(`Found ${categories.length} categories.`);

  let updated = 0;
  let skipped = 0;
  const seen = new Map();

  for (const cat of categories) {
    const documentId = field(cat, 'documentId');
    const currentSlug = field(cat, 'slug');
    const name = field(cat, 'name');
    if (!documentId || !currentSlug) {
      skipped++;
      continue;
    }

    const target =
      SLUG_MAP[currentSlug] || SLUG_MAP[normalizeSlug(currentSlug)] || normalizeSlug(currentSlug);
    if (!target || target === currentSlug) {
      skipped++;
      continue;
    }

    if (seen.has(target)) {
      console.warn(
        `Skip ${documentId} "${name}": slug "${currentSlug}" -> "${target}" would duplicate ${seen.get(target)}`
      );
      skipped++;
      continue;
    }

    console.log(`  ${currentSlug} -> ${target} (${name || documentId})`);
    if (!DRY_RUN) {
      const r = await api(`/api/categories/${documentId}`, {
        method: 'PUT',
        body: JSON.stringify({ data: { slug: target } }),
      });
      if (!r.ok) {
        console.error(`  FAILED HTTP ${r.status}`, r.json);
        continue;
      }
    }
    seen.set(target, documentId);
    updated++;
  }

  console.log(DRY_RUN ? `[dry-run] Would update ${updated}, skipped ${skipped}` : `Updated ${updated}, skipped ${skipped}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
