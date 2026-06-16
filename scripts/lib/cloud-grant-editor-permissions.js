'use strict';

/**
 * POST editor CM permissions grant to Strapi Cloud via /api/migration/fix-published.
 * Uses the existing migration route (already deployed on Cloud).
 */

try {
  require('dotenv').config();
} catch (_) {}

function getCloudConfig() {
  const baseUrl = (process.env.STRAPI_CLOUD_URL || '').replace(/\/+$/, '');
  const token =
    process.env.STRAPI_CLOUD_API_TOKEN ||
    process.env.STRAPI_MIGRATION_TOKEN ||
    process.env.STRAPI_API_TOKEN;
  if (!baseUrl) throw new Error('Set STRAPI_CLOUD_URL in .env');
  if (!token) throw new Error('Set STRAPI_CLOUD_API_TOKEN or STRAPI_MIGRATION_TOKEN in .env');
  return { baseUrl, token };
}

async function grantEditorPermissionsOnCloud(payload) {
  const { baseUrl, token } = getCloudConfig();
  const url = `${baseUrl}/api/migration/fix-published`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ grantEditorPermissions: payload }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (_) {
    body = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

module.exports = {
  getCloudConfig,
  grantEditorPermissionsOnCloud,
};
