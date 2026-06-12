'use strict';

/**
 * Deploy Kalpana schema to Strapi Cloud (if missing) and push local data.
 *
 * The Kalpana content types must exist on Cloud before REST push works.
 * Logging into the Cloud *admin panel* is not enough — you need either:
 *   - git push (if Cloud auto-deploy is enabled), or
 *   - npx strapi login && npx strapi deploy --force, or
 *   - STRAPI_CLOUD_TRANSFER_TOKEN + this script (transfer --only config)
 *
 * Create transfer token: Cloud admin → Settings → Global settings → Transfer Tokens
 *   → Create (Push or Full Access). Add to .env as STRAPI_CLOUD_TRANSFER_TOKEN.
 *
 * Usage:
 *   node scripts/complete-kalpana-cloud-import.js --tenant-id=tenant_demo_002
 *   node scripts/complete-kalpana-cloud-import.js --tenant-id=tenant_demo_002 --skip-deploy
 */

const { spawnSync } = require('child_process');
const path = require('path');

try {
  require('dotenv').config({
    path: path.join(__dirname, '..', '.env'),
    override: true,
  });
} catch (_) {}

const { getTenantId } = require('./lib/liturgy-cli');

const SKIP_DEPLOY = process.argv.includes('--skip-deploy');
const TENANT_ID = getTenantId({ defaultValue: 'tenant_demo_002' });
const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const TRANSFER_TOKEN = process.env.STRAPI_CLOUD_TRANSFER_TOKEN || '';

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function probeKalpanaApi() {
  const res = await fetch(`${CLOUD_URL}/api/kalpana-editions?pagination[pageSize]=1`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  return res.status;
}

function run(cmd, args, label) {
  console.log(`\n→ ${label}`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: true, cwd: path.join(__dirname, '..') });
  return result.status === 0;
}

function printDeployInstructions() {
  console.error('');
  console.error('Kalpana schema is not on Strapi Cloud yet (/api/kalpana-editions → 404).');
  console.error('');
  console.error('Choose ONE of these (admin panel login alone does not deploy code):');
  console.error('');
  console.error('  A) Git push (commit is ready locally):');
  console.error('       git push origin main');
  console.error('     Wait for Strapi Cloud to finish deploying, then re-run:');
  console.error('       npm run complete:kalpana-cloud-import -- --tenant-id=' + TENANT_ID);
  console.error('');
  console.error('  B) Strapi CLI deploy:');
  console.error('       npx strapi login');
  console.error('       npx strapi deploy --force');
  console.error('     Then re-run this script.');
  console.error('');
  console.error('  C) Transfer token (no git/CLI deploy):');
  console.error('       Cloud admin → Settings → Transfer Tokens → Create (Push)');
  console.error('       Add to .env: STRAPI_CLOUD_TRANSFER_TOKEN=...');
  console.error('       npm run complete:kalpana-cloud-import -- --tenant-id=' + TENANT_ID);
  console.error('');
}

async function tryDeploySchema() {
  if (SKIP_DEPLOY) return false;

  if (TRANSFER_TOKEN) {
    console.log('Attempting schema transfer (--only config) using STRAPI_CLOUD_TRANSFER_TOKEN...');
    const ok = run(
      'npx',
      [
        'strapi',
        'transfer',
        '--to',
        `${CLOUD_URL}/admin`,
        '--to-token',
        TRANSFER_TOKEN,
        '--only',
        'config',
        '--force',
      ],
      'strapi transfer --only config'
    );
    if (ok) return true;
    console.warn('Transfer config failed; trying CLI deploy...');
  }

  console.log('Attempting npx strapi deploy --force (requires prior npx strapi login)...');
  return run('npx', ['strapi', 'deploy', '--force'], 'strapi deploy');
}

async function waitForKalpanaApi(maxWaitMs = 20 * 60 * 1000) {
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    const status = await probeKalpanaApi();
    if (status === 200) {
      console.log('Cloud API ready: /api/kalpana-editions');
      return true;
    }
    if (status !== 404) {
      console.warn('Unexpected API status while waiting:', status);
    }
    console.log('Waiting for Kalpana schema on Cloud... (retry in 20s)');
    await sleep(20000);
  }
  return false;
}

async function main() {
  if (!CLOUD_URL || !API_TOKEN) {
    console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN in .env');
    process.exit(1);
  }

  console.log('Complete Kalpana Cloud import');
  console.log('  Cloud:', CLOUD_URL);
  console.log('  Tenant:', TENANT_ID);

  let status = await probeKalpanaApi();
  console.log('  /api/kalpana-editions status:', status);

  if (status === 404) {
    const deployed = await tryDeploySchema();
    if (!deployed) {
      printDeployInstructions();
      process.exit(1);
    }
    const ready = await waitForKalpanaApi();
    if (!ready) {
      console.error('Timed out waiting for Kalpana API on Cloud after deploy/transfer.');
      printDeployInstructions();
      process.exit(1);
    }
  } else if (status !== 200) {
    console.error('Unexpected Cloud API status:', status);
    process.exit(1);
  }

  const editionsOk = run(
    'node',
    ['./scripts/push-kalpana-editions-to-cloud.js', `--tenant-id=${TENANT_ID}`],
    'Push Kalpana editions'
  );
  if (!editionsOk) process.exit(1);

  const pageOk = run(
    'node',
    ['./scripts/push-kalpana-page-to-cloud.js', `--tenant-id=${TENANT_ID}`],
    'Push Kalpana page (single type)'
  );
  if (!pageOk) {
    console.warn('Kalpana page push failed or skipped (editions were pushed).');
  }

  status = await probeKalpanaApi();
  const countRes = await fetch(
    `${CLOUD_URL}/api/kalpana-editions?pagination[pageSize]=1&filters[tenant][tenantId][$eq]=${encodeURIComponent(TENANT_ID)}`,
    { headers: { Authorization: `Bearer ${API_TOKEN}` } }
  );
  const countJson = countRes.ok ? await countRes.json() : null;
  const total = countJson?.meta?.pagination?.total ?? '?';

  console.log('');
  console.log('Kalpana Cloud import finished.');
  console.log('  Editions on Cloud for tenant', TENANT_ID + ':', total);
  console.log('  Admin:', `${CLOUD_URL}/admin/content-manager/collection-types/api::kalpana-edition.kalpana-edition`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
