'use strict';

/**
 * Grant Editor role Content Manager permissions for Directory – Training on Strapi Cloud.
 * Calls POST /api/migration/grant-editor-permissions (requires deploy with that route).
 *
 * Env: STRAPI_CLOUD_URL, STRAPI_CLOUD_API_TOKEN (or STRAPI_MIGRATION_TOKEN)
 * Usage: npm run grant:editor-training-on-cloud
 */

try {
  require('dotenv').config();
} catch (_) {}

const {
  TRAINING_PROGRAM_SUBJECT,
} = require('../src/utils/editor-directory-permissions');

async function main() {
  const baseUrl = (process.env.STRAPI_CLOUD_URL || '').replace(/\/+$/, '');
  const token =
    process.env.STRAPI_CLOUD_API_TOKEN ||
    process.env.STRAPI_MIGRATION_TOKEN ||
    process.env.STRAPI_API_TOKEN;
  if (!baseUrl) {
    console.error('Set STRAPI_CLOUD_URL in .env');
    process.exit(1);
  }
  if (!token) {
    console.error('Set STRAPI_CLOUD_API_TOKEN or STRAPI_MIGRATION_TOKEN in .env');
    process.exit(1);
  }

  const url = `${baseUrl}/api/migration/grant-editor-permissions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ subjects: [TRAINING_PROGRAM_SUBJECT] }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (_) {
    body = { raw: text };
  }

  if (!res.ok) {
    console.error('HTTP', res.status, body);
    if (res.status === 404) {
      console.error(
        'Migration route not found. Deploy the latest Strapi code to Cloud, then run this script again.'
      );
    }
    process.exit(1);
  }

  console.log('Success:', JSON.stringify(body, null, 2));
  console.log('Editors should log out and back in to see Directory – Training in Content Manager.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
