#!/usr/bin/env node

/**
 * Normalize slug fields to lowercase kebab-case on Strapi Cloud (or any REST base URL).
 *
 * Types: categories, articles, tenants, bishops, dioceses, parishes, priests, directory-entries
 *
 * Usage:
 *   node scripts/normalize-production-slugs.mjs
 *   node scripts/normalize-production-slugs.mjs --dry-run
 *   node scripts/normalize-production-slugs.mjs --only=categories,articles
 *
 * Env: STRAPI_CLOUD_URL (or STRAPI_LOCAL_URL), STRAPI_CLOUD_API_TOKEN (or STRAPI_LOCAL_API_TOKEN)
 */

import 'dotenv/config';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { normalizeSlug } = require('../src/utils/normalize-slug.js');

const BASE_URL = (
  process.env.STRAPI_CLOUD_URL ||
  process.env.STRAPI_LOCAL_URL ||
  process.env.STRAPI_PRODUCTION_URL ||
  process.env.STRAPI_URL ||
  ''
).replace(/\/$/, '');

const API_TOKEN =
  process.env.STRAPI_CLOUD_API_TOKEN ||
  process.env.STRAPI_LOCAL_API_TOKEN ||
  process.env.STRAPI_PRODUCTION_API_TOKEN ||
  process.env.STRAPI_API_TOKEN ||
  '';

const CONTENT_TYPES = [
  { plural: 'categories', label: 'Category' },
  { plural: 'articles', label: 'Article', statusQuery: '&status=draft' },
  { plural: 'tenants', label: 'Tenant' },
  { plural: 'bishops', label: 'Bishop' },
  { plural: 'dioceses', label: 'Diocese' },
  { plural: 'parishes', label: 'Parish' },
  { plural: 'priests', label: 'Priest' },
  { plural: 'directory-entries', label: 'Directory entry' },
];

function arg(name, fallback = null) {
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === `--${name}` && process.argv[i + 1]) return process.argv[i + 1].trim();
    const m = a.match(new RegExp(`^--${name}=(.+)$`));
    if (m) return m[1].trim();
  }
  return fallback;
}

const DRY_RUN = process.argv.includes('--dry-run');
const ONLY = arg('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!BASE_URL || !API_TOKEN) {
  console.error('Set STRAPI_CLOUD_URL + STRAPI_CLOUD_API_TOKEN (or STRAPI_LOCAL_* for local).');
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

async function listAll(plural, statusQuery = '') {
  const out = [];
  let page = 1;
  while (true) {
    const r = await api(
      `/api/${plural}?pagination[page]=${page}&pagination[pageSize]=100${statusQuery}`
    );
    if (!r.ok) throw new Error(`List ${plural} failed HTTP ${r.status}`);
    const batch = rows(r.json);
    if (!batch.length) break;
    out.push(...batch);
    const pageCount = r.json?.meta?.pagination?.pageCount ?? 1;
    if (page >= pageCount) break;
    page++;
  }
  return out;
}

async function normalizeType({ plural, label, statusQuery = '' }) {
  const items = await listAll(plural, statusQuery);
  const slugSeen = new Map();
  let updated = 0;
  let skipped = 0;

  for (const item of items) {
    const documentId = field(item, 'documentId');
    const currentSlug = field(item, 'slug');
    const name = field(item, 'title') || field(item, 'name');
    if (!documentId || currentSlug == null || currentSlug === '') {
      skipped++;
      continue;
    }

    const target = normalizeSlug(currentSlug);
    if (!target || target === currentSlug) {
      skipped++;
      continue;
    }

    if (slugSeen.has(target)) {
      console.warn(
        `  [${label}] skip ${documentId}: "${currentSlug}" -> "${target}" duplicates ${slugSeen.get(target)}`
      );
      skipped++;
      continue;
    }

    console.log(`  [${label}] ${currentSlug} -> ${target}${name ? ` (${name})` : ''}`);
    if (!DRY_RUN) {
      const putPath =
        plural === 'articles'
          ? `/api/articles/${documentId}?status=draft`
          : `/api/${plural}/${documentId}`;
      const r = await api(putPath, {
        method: 'PUT',
        body: JSON.stringify({ data: { slug: target } }),
      });
      if (!r.ok) {
        console.error(`    FAILED HTTP ${r.status}`, r.json);
        continue;
      }
    }
    slugSeen.set(target, documentId);
    updated++;
  }

  return { label, total: items.length, updated, skipped };
}

async function main() {
  console.log(`Normalize slugs on ${BASE_URL}${DRY_RUN ? ' [dry-run]' : ''}`);
  const types = CONTENT_TYPES.filter(
    (t) => !ONLY.length || ONLY.includes(t.plural) || ONLY.includes(t.plural.replace(/-/g, ''))
  );

  const summary = [];
  for (const type of types) {
    console.log(`\n=== ${type.label} (${type.plural}) ===`);
    summary.push(await normalizeType(type));
  }

  console.log('\n=== SUMMARY ===');
  for (const s of summary) {
    console.log(`${s.label}: ${s.updated} updated, ${s.skipped} skipped (${s.total} total)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
