'use strict';

/**
 * Probe Strapi Cloud POST /api/upload (S3 or local provider on Cloud).
 * Usage: node scripts/probe-cloud-upload.js
 */

const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');

async function main() {
  if (!CLOUD_URL || !API_TOKEN) {
    console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN in .env');
    process.exit(1);
  }

  const files = fs.existsSync(UPLOADS_DIR)
    ? fs.readdirSync(UPLOADS_DIR).filter((f) => /\.(jpe?g|png|gif|webp)$/i.test(f))
    : [];
  if (files.length === 0) {
    console.error('No sample image in public/uploads/');
    process.exit(1);
  }

  const sample = path.join(UPLOADS_DIR, files[0]);
  const form = new FormData();
  form.append('files', fs.createReadStream(sample), {
    filename: path.basename(sample),
    contentType: 'image/jpeg',
  });

  console.log('Probing', `${CLOUD_URL}/api/upload`, 'with', path.basename(sample));
  const res = await fetch(`${CLOUD_URL}/api/upload`, {
    method: 'POST',
    body: form,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      ...form.getHeaders(),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (_) {
    body = text.slice(0, 500);
  }

  console.log('Status:', res.status);
  console.log('Response:', JSON.stringify(body, null, 2).slice(0, 1200));

  if (!res.ok) {
    console.error('\nCloud upload failed. Ensure Strapi Cloud has:');
    console.error('  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_S3_BUCKET_NAME');
    console.error('  UPLOAD_PROVIDER=aws-s3');
    process.exit(1);
  }

  const file = Array.isArray(body) ? body[0] : body;
  const url = file?.url ?? file?.data?.url;
  const provider = file?.provider ?? file?.data?.provider;
  console.log('\nUpload OK. provider:', provider, '| url:', url);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
