'use strict';

/**
 * Update upload file records from provider 'local' to 'aws-s3' so they point to
 * objects already uploaded to S3 under strapi-editorial-media/dev/ (or prod).
 *
 * Prerequisites:
 * 1. Files from public/uploads/ have been synced to S3, e.g.:
 *    aws s3 sync public/uploads/ s3://eventapp-media-bucket/strapi-editorial-media/dev/ --acl public-read
 *
 * 2. .env has AWS_S3_BUCKET_NAME, AWS_REGION (and optional S3_UPLOAD_PREFIX for dev/prod).
 *
 * Run (Strapi must be stopped):
 *   node scripts/migrate_upload_records_to_s3.js
 *   S3_UPLOAD_PREFIX=strapi-editorial-media/prod node scripts/migrate_upload_records_to_s3.js
 *
 * Default prefix: strapi-editorial-media/dev (for local dev). Use strapi-editorial-media/prod for production DB.
 */

try {
  require('dotenv').config();
} catch (_) {}

const bucket = process.env.AWS_S3_BUCKET_NAME || 'eventapp-media-bucket';
const region = process.env.AWS_REGION || 'us-east-2';
const prefix = (process.env.S3_UPLOAD_PREFIX || 'strapi-editorial-media/dev').replace(/\/+$/, '');
const baseUrl = `https://${bucket}.s3.${region}.amazonaws.com`;

function pathFromLocalUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = url.startsWith('http') ? new URL(url) : new URL(url, 'http://localhost');
    const p = u.pathname.replace(/^\/+/, '').replace(/^uploads\/?/i, '');
    return p || null;
  } catch (_) {
    return url.replace(/^\/+/, '').replace(/^uploads\/?/i, '');
  }
}

async function migrate(strapi) {
  const files = await strapi.db.query('plugin::upload.file').findMany({
    where: { provider: 'local' },
    select: ['id', 'documentId', 'url', 'provider_metadata'],
  });
  if (!files || files.length === 0) {
    console.log('No local upload files found.');
    return { updated: 0, skipped: 0, errors: 0 };
  }
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  for (const file of files) {
    const localPath = file.path || pathFromLocalUrl(file.url);
    if (!localPath) {
      console.warn('Skip file id=%s: no path or url', file.id);
      skipped++;
      continue;
    }
    const s3Key = prefix ? `${prefix}/${localPath}` : localPath;
    const s3Url = `${baseUrl}/${s3Key}`;
    const providerMetadata = {
      ...(typeof file.provider_metadata === 'object' && file.provider_metadata ? file.provider_metadata : {}),
      bucket,
      region,
      key: s3Key,
    };
    try {
      await strapi.db.query('plugin::upload.file').update({
        where: { id: file.id },
        data: {
          provider: 'aws-s3',
          url: s3Url,
          provider_metadata: providerMetadata,
        },
      });
      updated++;
      if (updated % 50 === 0) console.log('Updated', updated, 'files...');
    } catch (e) {
      console.error('Error updating file id=%s:', file.id, e.message);
      errors++;
    }
  }
  return { updated, skipped, errors };
}

async function main() {
  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  try {
    console.log('Bucket:', bucket, 'Region:', region, 'Prefix:', prefix);
    const result = await migrate(app);
    console.log('Done. Updated:', result.updated, 'Skipped:', result.skipped, 'Errors:', result.errors);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await app.destroy();
  }
  process.exit(process.exitCode || 0);
}

main();
