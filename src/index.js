'use strict';
const bootstrap = require("./bootstrap");

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
      const crypto = require('crypto');
      const { tenantDocumentId, articles } = ctx.request.body || {};

      // Validate Bearer token against env var or Strapi's hashed token store
      const authHeader = ctx.request.header.authorization || '';
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      if (!bearerToken) {
        ctx.status = 401;
        ctx.body = { error: { status: 401, message: 'Missing Bearer token.' } };
        return;
      }
      // Try direct match against env var first (simplest)
      const envToken = process.env.STRAPI_CLOUD_API_TOKEN || process.env.STRAPI_MIGRATION_TOKEN;
      let authorized = envToken && bearerToken === envToken;
      // Fallback: HMAC-SHA512 lookup in Strapi's token store
      if (!authorized) {
        try {
          const salt = strapi.config.get('admin.apiToken.salt') || process.env.API_TOKEN_SALT || '';
          const hashedToken = crypto.createHmac('sha512', salt).update(bearerToken).digest('hex');
          const storedToken = await strapi.db.query('admin::api-token').findOne({
            where: { accessKey: hashedToken },
          });
          if (storedToken) authorized = true;
        } catch (_) {}
      }
      if (!authorized) {
        ctx.status = 401;
        ctx.body = { error: { status: 401, message: 'Invalid API token.' } };
        return;
      }

      if (!Array.isArray(articles) || articles.length === 0) {
        ctx.status = 400;
        ctx.body = { error: { status: 400, message: 'articles array is required.' } };
        return;
      }

      const knex = strapi.db.connection;
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
