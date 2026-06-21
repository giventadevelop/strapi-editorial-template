'use strict';

try {
  require('dotenv').config();
} catch (_) {}

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';

if (!CLOUD_URL || !API_TOKEN) {
  console.error('Missing STRAPI_CLOUD_URL or STRAPI_CLOUD_API_TOKEN');
  process.exit(1);
}

async function cloudFetch(pathname) {
  const res = await fetch(`${CLOUD_URL}${pathname}`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const { CLONE_ORDER, pluralFromUid } = require('./lib/tenant-clone-config');

/** Draft-and-publish types need status=draft for REST count to match local inventory. */
const DRAFT_PUBLISH_UIDS = new Set([
  'api::article.article',
  'api::flash-news-item.flash-news-item',
]);

function parseTenantArg() {
  const arg = process.argv.find((a) => a.startsWith('--tenant-id='));
  if (arg) return arg.split('=')[1].trim();
  return 'mosc_malankara_orthodox_2';
}

async function count(plural, tenantId, uid) {
  const statusQs = uid && DRAFT_PUBLISH_UIDS.has(uid) ? '&status=draft' : '';
  const q = `/api/${plural}?filters[tenant][tenantId][$eq]=${encodeURIComponent(tenantId)}&pagination[pageSize]=1${statusQs}`;
  const data = await cloudFetch(q);
  return data.meta?.pagination?.total ?? 0;
}

async function main() {
  const tenantId = parseTenantArg();
  const full = process.argv.includes('--full');

  console.log('Cloud URL:', CLOUD_URL);
  const tenants = await cloudFetch('/api/tenants?pagination[pageSize]=50');
  const list = tenants.data || tenants.results || [];
  console.log('\nTenants on Cloud:');
  for (const t of list) {
    const tid = t.tenantId ?? t.attributes?.tenantId;
    const name = t.name ?? t.attributes?.name;
    console.log(`  - ${tid} (${name})`);
  }

  const targets = full ? [tenantId] : ['tenant_demo_002', 'mosc_malankara_orthodox_2'];
  const plurals = full
    ? CLONE_ORDER.map((uid) => ({ uid, plural: pluralFromUid(uid) }))
    : ['dioceses', 'parishes', 'articles', 'kalpana-documents'].map((plural) => ({
        uid: plural,
        plural,
      }));

  for (const tid of targets) {
    console.log(`\nCounts for ${tid}:`);
    let total = 0;
    for (const { uid, plural } of plurals) {
      try {
        const n = await count(plural, tid, full ? uid : null);
        total += n;
        if (full) console.log(`  ${uid.padEnd(48)} ${String(n).padStart(5)}`);
        else console.log(`  ${plural}: ${n}`);
      } catch (e) {
        const label = full ? uid : plural;
        console.log(`  ${label}: ERROR ${e.message}`);
      }
    }
    if (full) {
      console.log('-'.repeat(56));
      console.log('  TOTAL'.padEnd(48), String(total).padStart(5));
    }
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
