'use strict';

/**
 * Update upload file records that already point to S3 dev prefix to use the prod prefix.
 * Use this when you previously ran migrate:upload-records-to-s3 (dev) and now need
 * all URLs to point to strapi-editorial-media/prod/ for Strapi Cloud transfer.
 *
 * Prerequisites:
 * - Files are already in S3 under strapi-editorial-media/prod/
 * - DB records currently have url like .../strapi-editorial-media/dev/...
 *
 * Run (Strapi must be stopped):
 *   npm run migrate:upload-s3-dev-to-prod
 */

try {
  require('dotenv').config();
} catch (_) {}

const DEV_PREFIX = 'strapi-editorial-media/dev';
const PROD_PREFIX = 'strapi-editorial-media/prod';
const bucket = process.env.AWS_S3_BUCKET_NAME || 'eventapp-media-bucket';
const region = process.env.AWS_REGION || 'us-east-2';
const baseUrl = `https://${bucket}.s3.${region}.amazonaws.com`;

async function migrate(strapi) {
  const files = await strapi.db.query('plugin::upload.file').findMany({
    where: { provider: 'aws-s3' },
    select: ['id', 'url', 'provider_metadata'],
  });
  if (!files || files.length === 0) {
    console.log('No S3 upload files found.');
    return { updated: 0, skipped: 0, errors: 0 };
  }
  const toUpdate = files.filter(
    (f) =>
      (f.url && String(f.url).includes(DEV_PREFIX)) ||
      (f.provider_metadata && typeof f.provider_metadata === 'object' && f.provider_metadata.key && String(f.provider_metadata.key).includes(DEV_PREFIX))
  );
  if (toUpdate.length === 0) {
    console.log('No files found with dev prefix. All S3 URLs may already use prod.');
    return { updated: 0, skipped: files.length, errors: 0 };
  }
  let updated = 0;
  let errors = 0;
  for (const file of toUpdate) {
    const oldUrl = file.url || '';
    const newUrl = oldUrl.replace(DEV_PREFIX, PROD_PREFIX);
    const oldMeta = file.provider_metadata && typeof file.provider_metadata === 'object' ? file.provider_metadata : {};
    const oldKey = oldMeta.key || '';
    const newKey = oldKey ? String(oldKey).replace(DEV_PREFIX, PROD_PREFIX) : '';
    const providerMetadata = { ...oldMeta, bucket, region, key: newKey || oldKey };
    try {
      await strapi.db.query('plugin::upload.file').update({
        where: { id: file.id },
        data: {
          url: newUrl,
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
  return { updated, skipped: files.length - toUpdate.length, errors };
}

async function main() {
  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  try {
    console.log('Converting S3 URLs from', DEV_PREFIX, '->', PROD_PREFIX);
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
