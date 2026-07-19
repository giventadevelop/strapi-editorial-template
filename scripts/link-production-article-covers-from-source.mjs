#!/usr/bin/env node

/**
 * Copy article cover media from a source tenant to a cloned target tenant on Strapi Cloud.
 *
 * Matches target articles by slug = sourceSlug + suffix (default -mo2).
 * Reuses existing Cloud upload file IDs (no re-upload). Links draft + published rows.
 *
 * Usage:
 *   node scripts/link-production-article-covers-from-source.mjs --source-tenant-id=tenant_demo_002 --target-tenant-id=mosc_malankara_orthodox_2 --slug-suffix=-mo2
 *   node scripts/link-production-article-covers-from-source.mjs --source-tenant-id=tenant_demo_002 --target-tenant-id=mosc_malankara_orthodox_2 --slug-suffix=-mo2 --dry-run
 *
 * Env: STRAPI_CLOUD_URL, STRAPI_CLOUD_API_TOKEN
 */

import 'dotenv/config';

const BASE_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';

function arg(name, fallback = null) {
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === `--${name}` && process.argv[i + 1]) return process.argv[i + 1].trim();
    const m = a.match(new RegExp(`^--${name}=(.+)$`));
    if (m) return m[1].trim();
  }
  return fallback;
}

const SOURCE_TENANT_ID = arg('source-tenant-id', 'tenant_demo_002');
const TARGET_TENANT_ID = arg('target-tenant-id', process.env.TENANT_ID || 'mosc_malankara_orthodox_2');
const SLUG_SUFFIX = arg('slug-suffix', '-mo2');
const DELAY_MS = Math.max(0, Number(arg('delay-ms', '50')) || 50);
const DRY_RUN = process.argv.includes('--dry-run');

if (!BASE_URL || !API_TOKEN) {
  console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN.');
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  return { status: res.status, ok: res.ok, json, text };
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

function coverFileId(article) {
  const cover = field(article, 'cover');
  if (!cover) return null;
  if (cover.data) {
    const d = Array.isArray(cover.data) ? cover.data[0] : cover.data;
    return d?.id ?? field(d, 'id') ?? null;
  }
  return cover.id ?? field(cover, 'id') ?? null;
}

/** Match clone slug suffix after local kebab normalization (dots → hyphens). */
function kebabSlug(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

function targetSlugCandidates(sourceSlug, suffix) {
  const raw = String(sourceSlug || '');
  const candidates = [
    `${raw}${suffix}`,
    `${kebabSlug(raw)}${suffix}`,
    `${raw.replace(/\./g, '-')}${suffix}`,
  ];
  // Dedupe while preserving order
  return [...new Set(candidates.filter(Boolean))];
}

async function listSourceArticlesWithCover(tenantId) {
  const out = [];
  let page = 1;
  while (true) {
    const qs =
      `filters[tenant][tenantId][$eq]=${encodeURIComponent(tenantId)}` +
      `&filters[publishedAt][$notNull]=true` +
      `&populate[0]=cover` +
      `&pagination[page]=${page}&pagination[pageSize]=100` +
      `&sort=id:asc`;
    const r = await api(`/api/articles?${qs}`);
    if (!r.ok) throw new Error(`Source list failed page=${page} HTTP ${r.status}: ${JSON.stringify(r.json?.error || r.json)}`);
    const list = rows(r.json);
    for (const a of list) {
      const slug = field(a, 'slug');
      const fileId = coverFileId(a);
      if (slug && fileId != null) {
        out.push({
          slug,
          fileId,
          documentId: field(a, 'documentId'),
          coverUrl: field(field(a, 'cover'), 'url'),
        });
      }
    }
    const pagination = r.json?.meta?.pagination;
    if (!pagination || page >= pagination.pageCount) break;
    page++;
  }
  return out;
}

async function findTargetBySlugCandidates(candidates) {
  // Prefer published row lookup; fall back to draft (tenant-scoped clones live as drafts too).
  for (const slug of candidates) {
    for (const statusQs of ['', '&status=draft']) {
      const r = await api(
        `/api/articles?filters[slug][$eq]=${encodeURIComponent(slug)}&populate[0]=cover&pagination[pageSize]=1${statusQs}`
      );
      if (!r.ok) continue;
      const a = rows(r.json)[0];
      if (a) {
        return {
          slug,
          documentId: field(a, 'documentId'),
          hasCover: !!field(a, 'cover'),
          publishedAt: field(a, 'publishedAt'),
        };
      }
    }
  }
  return null;
}

async function putCover(documentId, fileId, status) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return api(`/api/articles/${documentId}${qs}`, {
    method: 'PUT',
    body: JSON.stringify({ data: { cover: fileId } }),
  });
}

async function publishArticle(documentId) {
  return api(`/api/articles/${documentId}/actions/publish`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

async function main() {
  console.log('Link production article covers from source tenant');
  console.log(`baseUrl=${BASE_URL}`);
  console.log(`source=${SOURCE_TENANT_ID}`);
  console.log(`target=${TARGET_TENANT_ID}`);
  console.log(`slugSuffix=${SLUG_SUFFIX}`);
  if (DRY_RUN) console.log('DRY RUN enabled.');

  const sources = await listSourceArticlesWithCover(SOURCE_TENANT_ID);
  console.log(`source articles with cover: ${sources.length}`);

  const stats = {
    linked: 0,
    skippedNoTarget: 0,
    skippedAlready: 0,
    published: 0,
    errors: [],
  };

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    const candidates = targetSlugCandidates(src.slug, SLUG_SUFFIX);
    const target = await findTargetBySlugCandidates(candidates);

    if (!target?.documentId) {
      stats.skippedNoTarget++;
      if (stats.skippedNoTarget <= 8) {
        console.log(`  skip (no target): tried ${candidates.join(' | ')}`);
      }
      continue;
    }

    const targetSlug = target.slug;

    if (DRY_RUN) {
      console.log(`  [dry-run] ${src.slug} → ${targetSlug} fileId=${src.fileId} doc=${target.documentId}`);
      stats.linked++;
      continue;
    }

    try {
      // Link on draft (default Document API row).
      const draftPut = await putCover(target.documentId, src.fileId, 'draft');
      if (!draftPut.ok) {
        throw new Error(`draft PUT HTTP ${draftPut.status}: ${JSON.stringify(draftPut.json?.error || draftPut.json)}`);
      }

      // Also link published row when it exists.
      if (target.publishedAt) {
        const pubPut = await putCover(target.documentId, src.fileId, 'published');
        if (!pubPut.ok) {
          // Fallback: re-publish so published picks up draft relations.
          const pub = await publishArticle(target.documentId);
          if (!pub.ok) {
            throw new Error(
              `published PUT HTTP ${pubPut.status}; publish HTTP ${pub.status}: ${JSON.stringify(pub.json?.error || pub.json)}`
            );
          }
          stats.published++;
        }
      } else {
        const pub = await publishArticle(target.documentId);
        if (pub.ok) stats.published++;
      }

      stats.linked++;
      if ((i + 1) % 10 === 0 || i === sources.length - 1) {
        console.log(`  progress ${i + 1}/${sources.length} linked=${stats.linked}`);
      }
    } catch (err) {
      stats.errors.push({ targetSlug, error: err.message });
      console.error(`  ERROR ${targetSlug}: ${err.message}`);
    }

    if (DELAY_MS) await sleep(DELAY_MS);
  }

  // Verify: published target-tenant articles with cover
  const verify = await api(
    `/api/articles?filters[slug][$contains]=${encodeURIComponent(SLUG_SUFFIX)}` +
      `&filters[publishedAt][$notNull]=true&populate[0]=cover&pagination[pageSize]=5&sort=publishedAt:desc`
  );
  const verifyRows = rows(verify.json);
  const withCover = verifyRows.filter((a) => !!field(a, 'cover')).length;

  // Count covers across all -mo2 published (sample pages)
  let page = 1;
  let checked = 0;
  let coverCount = 0;
  let total = 0;
  while (page <= 10) {
    const r = await api(
      `/api/articles?filters[slug][$contains]=${encodeURIComponent(SLUG_SUFFIX)}` +
        `&filters[publishedAt][$notNull]=true&populate[0]=cover&pagination[page]=${page}&pagination[pageSize]=100`
    );
    if (!r.ok) break;
    const list = rows(r.json);
    total = r.json?.meta?.pagination?.total ?? total;
    for (const a of list) {
      checked++;
      if (field(a, 'cover')) coverCount++;
    }
    if (!r.json?.meta?.pagination || page >= r.json.meta.pagination.pageCount) break;
    page++;
  }

  console.log('\n=== SUMMARY ===');
  console.log(`linked=${stats.linked}, skippedNoTarget=${stats.skippedNoTarget}, publishedActions=${stats.published}, errors=${stats.errors.length}`);
  console.log(`verify sample: ${withCover}/${verifyRows.length} have cover`);
  console.log(`verify all ${SLUG_SUFFIX} published: ${coverCount}/${checked} have cover (total=${total})`);
  if (stats.errors.length) {
    console.log('errors (first 10):', JSON.stringify(stats.errors.slice(0, 10), null, 2));
  }
  console.log(
    JSON.stringify(
      verifyRows.slice(0, 3).map((a) => ({
        slug: field(a, 'slug'),
        hasCover: !!field(a, 'cover'),
        coverUrl: field(field(a, 'cover'), 'url'),
      })),
      null,
      2
    )
  );

  if (stats.errors.length > 0) process.exit(2);
}

main().catch((e) => {
  console.error('Cover link failed:', e?.message || e);
  process.exit(1);
});
