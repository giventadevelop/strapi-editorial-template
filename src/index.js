'use strict';
const bootstrap = require("./bootstrap");

async function ensureMigrationAuthorized(strapi, ctx) {
  const crypto = require('crypto');
  const authHeader = ctx.request.header.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!bearerToken) {
    ctx.status = 401;
    ctx.body = { error: { status: 401, message: 'Missing Bearer token.' } };
    return false;
  }
  const envToken = process.env.STRAPI_CLOUD_API_TOKEN || process.env.STRAPI_MIGRATION_TOKEN;
  if (envToken && bearerToken === envToken) return true;
  try {
    const salt = strapi.config.get('admin.apiToken.salt') || process.env.API_TOKEN_SALT || '';
    const hashedToken = crypto.createHmac('sha512', salt).update(bearerToken).digest('hex');
    const storedToken = await strapi.db.query('admin::api-token').findOne({
      where: { accessKey: hashedToken },
    });
    if (storedToken) return true;
  } catch (_) {}
  ctx.status = 401;
  ctx.body = { error: { status: 401, message: 'Invalid API token.' } };
  return false;
}

module.exports = {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register({ strapi }) {
    // Temporary migration endpoint — remove after migration is complete.
    // POST /api/migration/fix-published
    // Directly updates publishedAt and tenant on published DB rows via raw knex.
    strapi.server.router.post('/api/migration/fix-published', async (ctx) => {
      if (!(await ensureMigrationAuthorized(strapi, ctx))) return;
      const body = ctx.request.body || {};
      const {
        tenantDocumentId,
        articles,
        uploadMedia,
        linkCatholicateImages,
        tenantId: catholicateTenantId,
      } = body;

      const knex = strapi.db.connection;
      const fs = require('fs');
      const path = require('path');

      // Catholicate image migration (base64 upload + morph link) — works when /api/upload is broken.
      if (Array.isArray(uploadMedia) && uploadMedia.length > 0) {
        const uploadsDir = path.join(strapi.dirs.static.public, 'uploads');
        fs.mkdirSync(uploadsDir, { recursive: true });
        const created = [];
        const errors = [];
        for (const item of uploadMedia) {
          const { name, hash, ext, mime, base64, size, width, height } = item || {};
          if (!name || !hash || !ext || !base64) {
            errors.push({ name: name || '?', error: 'name, hash, ext, and base64 are required.' });
            continue;
          }
          const normalizedExt = ext.startsWith('.') ? ext : `.${ext}`;
          const filename = `${hash}${normalizedExt}`;
          const diskPath = path.join(uploadsDir, filename);
          try {
            const buf = Buffer.from(base64, 'base64');
            fs.writeFileSync(diskPath, buf);
            const existing = await strapi.db.query('plugin::upload.file').findOne({
              where: { hash },
              select: ['id', 'documentId', 'document_id', 'url'],
            });
            if (existing) {
              created.push({ id: existing.id, name, hash, reused: true });
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
                size: size || buf.length,
                width: width ?? null,
                height: height ?? null,
                url: `/uploads/${filename}`,
                provider: 'local',
              },
            });
            created.push({ id: row.id, name, hash, reused: false });
          } catch (err) {
            errors.push({ name, error: err.message });
          }
        }

        let linkResults = null;
        if (Array.isArray(linkCatholicateImages) && linkCatholicateImages.length > 0 && catholicateTenantId) {
          linkResults = { linked: 0, skipped: 0, errors: [] };
          const tenantRow = await knex('tenants').where({ tenant_id: catholicateTenantId }).select('id').first();
          const contentUid = 'api::catholicate-entry.catholicate-entry';
          const morphTable = 'files_related_mph';
          const byHash = new Map(created.map((c) => [c.hash, c.id]));
          for (const link of linkCatholicateImages) {
            const { slug, hash, fileId } = link || {};
            const resolvedId = fileId ?? (hash ? byHash.get(hash) : null);
            if (!slug || resolvedId == null) {
              linkResults.skipped++;
              continue;
            }
            try {
              if (!tenantRow) throw new Error(`Tenant not found: ${catholicateTenantId}`);
              const entryRow = await knex('catholicate_entries as e')
                .join('catholicate_entries_tenant_lnk as tl', 'tl.catholicate_entry_id', 'e.id')
                .where({ 'e.slug': slug, 'tl.tenant_id': tenantRow.id })
                .select('e.id')
                .first();
              if (!entryRow) throw new Error('Entry not found for tenant.');
              await knex(morphTable)
                .where({ related_id: entryRow.id, related_type: contentUid, field: 'image' })
                .del();
              await knex(morphTable).insert({
                file_id: resolvedId,
                related_id: entryRow.id,
                related_type: contentUid,
                field: 'image',
                order: 1,
              });
              linkResults.linked++;
            } catch (err) {
              linkResults.errors.push({ slug, error: err.message });
            }
          }
        }

        ctx.body = { ok: errors.length === 0, created, errors, linkResults };
        return;
      }

      if (!Array.isArray(articles) || articles.length === 0) {
        ctx.status = 400;
        ctx.body = { error: { status: 400, message: 'articles array is required (or send uploadMedia).' } };
        return;
      }

      const results = { updated: 0, tenantLinked: 0, skipped: 0, errors: [] };

      // Resolve tenant numeric ID from documentId
      let tenantNumericId = null;
      if (tenantDocumentId) {
        const tenantRow = await knex('tenants')
          .where({ document_id: tenantDocumentId })
          .select('id')
          .first();
        if (!tenantRow) {
          ctx.status = 400;
          ctx.body = { error: { status: 400, message: `Tenant not found: ${tenantDocumentId}` } };
          return;
        }
        tenantNumericId = tenantRow.id;
      }

      // Discover link table for tenant relation per content type
      const linkTableCache = {};
      function getLinkTableInfo(uid) {
        if (linkTableCache[uid]) return linkTableCache[uid];
        try {
          const meta = strapi.db.metadata.get(uid);
          const attrs = meta?.attributes;
          const tenantAttr = attrs instanceof Map ? attrs.get('tenant') : attrs?.tenant;
          const jt = tenantAttr?.joinTable;
          if (jt?.name && jt?.joinColumn?.name && jt?.inverseJoinColumn?.name) {
            linkTableCache[uid] = {
              table: jt.name,
              srcCol: jt.joinColumn.name,
              tgtCol: jt.inverseJoinColumn.name,
              ordCol: jt.orderColumnName || null,
            };
            return linkTableCache[uid];
          }
        } catch (_) {}
        linkTableCache[uid] = null;
        return null;
      }

      for (const item of articles) {
        const { documentId, publishedAt, uid } = item;
        const contentUid = uid || 'api::article.article';
        if (!documentId) { results.skipped++; continue; }

        try {
          const ct = strapi.contentType(contentUid);
          if (!ct?.collectionName) {
            results.errors.push({ documentId, error: `Unknown content type: ${contentUid}` });
            continue;
          }
          const tableName = ct.collectionName;

          // Find the published row
          const publishedRow = await knex(tableName)
            .where({ document_id: documentId })
            .whereNotNull('published_at')
            .select('id', 'published_at')
            .first();

          if (!publishedRow) { results.skipped++; continue; }

          // Update publishedAt on both published and draft rows
          if (publishedAt) {
            await knex(tableName)
              .where({ id: publishedRow.id })
              .update({ published_at: publishedAt });
            await knex(tableName)
              .where({ document_id: documentId })
              .whereNull('published_at')
              .update({ published_at: publishedAt });
            results.updated++;
          }

          // Ensure tenant link on published row
          if (tenantNumericId) {
            const linkInfo = getLinkTableInfo(contentUid);
            if (linkInfo) {
              const existingLink = await knex(linkInfo.table)
                .where({ [linkInfo.srcCol]: publishedRow.id })
                .first();

              if (existingLink) {
                if (existingLink[linkInfo.tgtCol] !== tenantNumericId) {
                  await knex(linkInfo.table)
                    .where({ [linkInfo.srcCol]: publishedRow.id })
                    .update({ [linkInfo.tgtCol]: tenantNumericId });
                  results.tenantLinked++;
                }
              } else {
                const draftRow = await knex(tableName)
                  .where({ document_id: documentId })
                  .whereNull('published_at')
                  .select('id')
                  .first();
                let ordValue = 1;
                if (draftRow && linkInfo.ordCol) {
                  const draftLink = await knex(linkInfo.table)
                    .where({ [linkInfo.srcCol]: draftRow.id })
                    .first();
                  if (draftLink && draftLink[linkInfo.ordCol] != null) {
                    ordValue = draftLink[linkInfo.ordCol];
                  }
                }
                const ins = {
                  [linkInfo.srcCol]: publishedRow.id,
                  [linkInfo.tgtCol]: tenantNumericId,
                };
                if (linkInfo.ordCol) ins[linkInfo.ordCol] = ordValue;
                await knex(linkInfo.table).insert(ins);
                results.tenantLinked++;
              }
            }
          }
        } catch (err) {
          results.errors.push({ documentId, error: err.message });
        }
      }

      ctx.body = { ok: true, results };
    });

    // POST /api/migration/register-s3-media
    // Create plugin::upload.file rows for objects already in the shared S3 bucket (prod prefix).
    // Used when Cloud /api/upload returns 500 but files were synced to S3 separately.
    strapi.server.router.post('/api/migration/register-s3-media', async (ctx) => {
      if (!(await ensureMigrationAuthorized(strapi, ctx))) return;
      const { files, prefix } = ctx.request.body || {};
      if (!Array.isArray(files) || files.length === 0) {
        ctx.status = 400;
        ctx.body = { error: { status: 400, message: 'files array is required.' } };
        return;
      }

      const bucket = process.env.AWS_S3_BUCKET_NAME || 'eventapp-media-bucket';
      const region = process.env.AWS_REGION || 'us-east-2';
      const rootPath = (prefix || process.env.S3_UPLOAD_PREFIX || 'strapi-editorial-media/prod').replace(/\/+$/, '');
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
            select: ['id', 'documentId', 'document_id', 'url'],
          });
          if (existing) {
            created.push({
              id: existing.id,
              documentId: existing.documentId ?? existing.document_id,
              url: existing.url,
              name,
              reused: true,
            });
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
            reused: false,
          });
        } catch (err) {
          errors.push({ name, error: err.message });
        }
      }

      ctx.body = { ok: errors.length === 0, created, errors };
    });

    // POST /api/migration/link-catholicate-images
    // Link upload file IDs to catholicate entries by slug + tenantId (files_related_mph).
    strapi.server.router.post('/api/migration/link-catholicate-images', async (ctx) => {
      if (!(await ensureMigrationAuthorized(strapi, ctx))) return;
      const { tenantId, links } = ctx.request.body || {};
      if (!tenantId || !Array.isArray(links) || links.length === 0) {
        ctx.status = 400;
        ctx.body = { error: { status: 400, message: 'tenantId and links array are required.' } };
        return;
      }

      const knex = strapi.db.connection;
      const tenantRow = await knex('tenants').where({ tenant_id: tenantId }).select('id').first();
      if (!tenantRow) {
        ctx.status = 400;
        ctx.body = { error: { status: 400, message: `Tenant not found: ${tenantId}` } };
        return;
      }

      const contentUid = 'api::catholicate-entry.catholicate-entry';
      const morphTable = 'files_related_mph';
      const results = { linked: 0, skipped: 0, errors: [] };

      for (const link of links) {
        const { slug, fileId } = link || {};
        if (!slug || fileId == null) {
          results.skipped++;
          continue;
        }
        try {
          const entryRow = await knex('catholicate_entries as e')
            .join('catholicate_entries_tenant_lnk as tl', 'tl.catholicate_entry_id', 'e.id')
            .where({ 'e.slug': slug, 'tl.tenant_id': tenantRow.id })
            .select('e.id')
            .first();
          if (!entryRow) {
            results.errors.push({ slug, error: 'Entry not found for tenant.' });
            continue;
          }
          const fileRow = await knex('files').where({ id: fileId }).select('id').first();
          if (!fileRow) {
            results.errors.push({ slug, error: `File id ${fileId} not found.` });
            continue;
          }
          await knex(morphTable)
            .where({ related_id: entryRow.id, related_type: contentUid, field: 'image' })
            .del();
          await knex(morphTable).insert({
            file_id: fileId,
            related_id: entryRow.id,
            related_type: contentUid,
            field: 'image',
            order: 1,
          });
          results.linked++;
        } catch (err) {
          results.errors.push({ slug, error: err.message });
        }
      }

      ctx.body = { ok: results.errors.length === 0, results };
    });
  },

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  bootstrap,
};
