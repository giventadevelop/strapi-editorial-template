'use strict';

/**
 * Delete empty Cloud article shells (no title + no slug) left by cover-only PUTs,
 * then re-push production news content and repair tenants / covers / dates.
 *
 *   node scripts/repair-cloud-news-sync.js --tenant-id=mosc_malankara_orthodox_2
 */

try {
  require('dotenv').config();
} catch (_) {}

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const TENANT_ID =
  (process.argv.find((a) => a.startsWith('--tenant-id=')) || '').split('=')[1] ||
  'mosc_malankara_orthodox_2';
const DRY_RUN = process.argv.includes('--dry-run');

async function cloudFetch(pathname, options = {}) {
  const url = pathname.startsWith('http') ? pathname : `${CLOUD_URL}${pathname}`;
  const res = await fetch(url, {
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
    json = { raw: text?.slice(0, 400) };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}: ${text.slice(0, 300)}`);
  return json;
}

async function deleteEmptyShells() {
  const toDelete = [];
  let page = 1;
  while (true) {
    const json = await cloudFetch(
      `/api/articles?pagination[page]=${page}&pagination[pageSize]=100&fields[0]=title&fields[1]=slug&fields[2]=createdAt`
    );
    for (const row of json.data || []) {
      if (!row.title && !row.slug) toDelete.push(row.documentId);
    }
    if (!json.meta || page >= json.meta.pagination.pageCount) break;
    page++;
  }
  console.log(`Empty article shells: ${toDelete.length}`);
  if (DRY_RUN) return toDelete.length;
  let deleted = 0;
  for (const docId of toDelete) {
    try {
      await cloudFetch(`/api/articles/${docId}`, { method: 'DELETE' });
      deleted++;
    } catch (e) {
      console.warn('  Delete shell failed', docId, e.message);
    }
  }
  console.log(`Deleted empty shells: ${deleted}`);
  return deleted;
}

async function linkTenantsForRecent(uid, plural, sinceIso) {
  const tenantRes = await cloudFetch(
    `/api/tenants?filters[tenantId][$eq]=${encodeURIComponent(TENANT_ID)}&pagination[pageSize]=1`
  );
  const tenantDocumentId = tenantRes.data?.[0]?.documentId;
  if (!tenantDocumentId) throw new Error('Cloud tenant not found');

  const docs = [];
  let page = 1;
  while (true) {
    const fields =
      plural === 'flash-news-items'
        ? 'fields[0]=title&fields[1]=createdAt&fields[2]=order'
        : 'fields[0]=title&fields[1]=slug&fields[2]=createdAt';
    const json = await cloudFetch(
      `/api/${plural}?pagination[page]=${page}&pagination[pageSize]=100&${fields}&populate[tenant]=true&sort=createdAt:desc`
    );
    for (const row of json.data || []) {
      if (row.createdAt && row.createdAt >= sinceIso) {
        if (!row.tenant?.tenantId) docs.push(row.documentId);
      }
    }
    if (!json.meta || page >= json.meta.pagination.pageCount || page > 5) break;
    page++;
  }
  console.log(`Tenant-less ${plural} since ${sinceIso}: ${docs.length}`);
  if (DRY_RUN || !docs.length) return;

  for (let i = 0; i < docs.length; i += 20) {
    const batch = docs.slice(i, i + 20).map((documentId) => ({ documentId, uid }));
    const r = await cloudFetch('/api/migration/fix-published', {
      method: 'POST',
      body: JSON.stringify({ tenantDocumentId, articles: batch }),
    });
    console.log(`  fix-published batch ${Math.floor(i / 20) + 1}:`, r.results || r);
  }
}

async function main() {
  if (!CLOUD_URL || !API_TOKEN) {
    console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN');
    process.exit(1);
  }
  console.log('Repair Cloud news sync');
  console.log('  Cloud:', CLOUD_URL);
  console.log('  Tenant:', TENANT_ID);
  console.log('  Dry run:', DRY_RUN);

  await deleteEmptyShells();

  if (DRY_RUN) {
    console.log('Dry run done.');
    return;
  }

  const { spawnSync } = require('child_process');
  const run = (cmd, args) => {
    console.log('\n>', cmd, args.join(' '));
    const r = spawnSync(cmd, args, {
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    });
    if (r.status !== 0) throw new Error(`Command failed: ${cmd} ${args.join(' ')}`);
  };

  const sinceIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  run('npm', [
    'run',
    'push:tenant-to-cloud',
    '--',
    `--tenant-id=${TENANT_ID}`,
    '--types=articles,flash-news-items,advertisement-slots',
    '--force',
    '--delay-ms=80',
  ]);

  await linkTenantsForRecent('api::article.article', 'articles', sinceIso);
  await linkTenantsForRecent('api::flash-news-item.flash-news-item', 'flash-news-items', sinceIso);

  run('npm', [
    'run',
    'sync:article-published-dates-cloud',
    '--',
    `--tenant-id=${TENANT_ID}`,
  ]);

  run('npm', [
    'run',
    'push:collection-images-s3-to-cloud',
    '--',
    '--collection=articles',
    `--tenant-id=${TENANT_ID}`,
    '--skip-api',
  ]);

  run('npm', [
    'run',
    'push:collection-images-s3-to-cloud',
    '--',
    '--collection=advertisement-slots',
    `--tenant-id=${TENANT_ID}`,
    '--skip-api',
  ]);

  // Cover PUT can drop tenant again — re-link articles after S3.
  await linkTenantsForRecent('api::article.article', 'articles', sinceIso);
  await linkTenantsForRecent('api::flash-news-item.flash-news-item', 'flash-news-items', sinceIso);

  // Final tenant verify
  const arts = await cloudFetch(
    `/api/articles?filters[tenant][tenantId][$eq]=${encodeURIComponent(TENANT_ID)}&filters[publishedAt][$notNull]=true&pagination[pageSize]=5&populate=cover&sort=publishedAt:desc`
  );
  const flash = await cloudFetch(
    `/api/flash-news-items?filters[tenant][tenantId][$eq]=${encodeURIComponent(TENANT_ID)}&filters[publishedAt][$notNull]=true&pagination[pageSize]=10&sort=order:asc`
  );
  const ads = await cloudFetch(
    `/api/advertisement-slots?filters[tenant][tenantId][$eq]=${encodeURIComponent(TENANT_ID)}&populate=media&pagination[pageSize]=10`
  );
  console.log('\n=== VERIFY ===');
  console.log('articles by tenant:', arts.meta?.pagination?.total, 'sample', (arts.data || []).map((a) => ({ slug: a.slug, cover: !!a.cover?.url })));
  console.log('flash by tenant:', flash.meta?.pagination?.total);
  console.log(
    'ads by tenant:',
    ads.meta?.pagination?.total,
    (ads.data || []).map((a) => ({ position: a.position, s3: String(a.media?.url || '').includes('amazonaws') }))
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
