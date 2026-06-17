'use strict';

/**
 * Register or upgrade plugin::upload.file rows to point at S3 URLs.
 */
async function registerOrUpgradeS3Files(strapi, files, options = {}) {
  const bucket = process.env.AWS_S3_BUCKET_NAME || 'eventapp-media-bucket';
  const region = process.env.AWS_REGION || 'us-east-2';
  const rootPath = (options.prefix || process.env.S3_UPLOAD_PREFIX || 'strapi-editorial-media/prod').replace(
    /\/+$/,
    ''
  );
  const baseUrl = `https://${bucket}.s3.${region}.amazonaws.com`;

  const created = [];
  const errors = [];

  for (const item of files) {
    const { name, hash, ext, mime, size, width, height, relativePath } = item || {};
    if (!name || !hash || !ext) {
      errors.push({ name: name || '?', error: 'name, hash, and ext are required.' });
      continue;
    }
    const normalizedExt = ext.startsWith('.') ? ext : `.${ext}`;
    const rel = relativePath || `${hash}${normalizedExt}`;
    const s3Key = rootPath ? `${rootPath}/${rel}` : rel;
    const s3Url = `${baseUrl}/${s3Key}`;

    try {
      const existing = await strapi.db.query('plugin::upload.file').findOne({
        where: { hash },
        select: ['id', 'documentId', 'document_id', 'url', 'provider'],
      });
      if (existing) {
        const needsS3Upgrade =
          !existing.url ||
          String(existing.url).startsWith('/uploads/') ||
          existing.provider === 'local' ||
          !String(existing.url).includes('amazonaws.com');
        if (needsS3Upgrade) {
          await strapi.db.query('plugin::upload.file').update({
            where: { id: existing.id },
            data: {
              url: s3Url,
              provider: 'aws-s3',
              provider_metadata: { bucket, region, key: s3Key },
            },
          });
          created.push({
            id: existing.id,
            documentId: existing.documentId ?? existing.document_id,
            url: s3Url,
            name,
            hash,
            reused: true,
            upgraded: true,
          });
        } else {
          created.push({
            id: existing.id,
            documentId: existing.documentId ?? existing.document_id,
            url: existing.url,
            name,
            hash,
            reused: true,
            upgraded: false,
          });
        }
        continue;
      }

      const row = await strapi.db.query('plugin::upload.file').create({
        data: {
          name,
          alternativeText: name,
          caption: name,
          hash,
          ext: normalizedExt,
          mime: mime || 'application/octet-stream',
          size: size || 0,
          width: width ?? null,
          height: height ?? null,
          url: s3Url,
          provider: 'aws-s3',
          provider_metadata: { bucket, region, key: s3Key },
        },
      });
      created.push({
        id: row.id,
        documentId: row.documentId ?? row.document_id,
        url: row.url,
        name,
        hash,
        reused: false,
        upgraded: false,
      });
    } catch (err) {
      errors.push({ name, error: err.message });
    }
  }

  return { ok: errors.length === 0, created, errors };
}

module.exports = { registerOrUpgradeS3Files };
