'use strict';

/**
 * Ensure an admin user has the Editor role (code: strapi-editor) on Strapi Cloud.
 * Requires Cloud deploy that includes ensureAdminEditorRole on POST /api/migration/fix-published.
 *
 * Usage:
 *   node scripts/ensure-admin-editor-on-cloud.js mosc.regular.user@keleno.com
 */
require('dotenv').config();

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const email = (process.argv[2] || 'mosc.regular.user@keleno.com').trim().toLowerCase();

async function main() {
  if (!CLOUD_URL || !API_TOKEN) {
    console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN');
    process.exit(1);
  }
  const res = await fetch(`${CLOUD_URL}/api/migration/fix-published`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ensureAdminEditorRole: { email } }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  console.log('status', res.status);
  console.log(JSON.stringify(json, null, 2));
  if (!res.ok || json.ok === false) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
