'use strict';

/**
 * One-time migration controller: directly update publishedAt and tenant on
 * PUBLISHED article rows via raw DB queries.  Bypasses the normal publish flow
 * (lifecycle hooks, document middleware) so it cannot trigger timeouts or 500s.
 *
 * POST /api/migration/fix-published
 * Body: {
 *   token: "<STRAPI_CLOUD_API_TOKEN>",        // simple auth guard
 *   tenantDocumentId: "<cloud tenant docId>",  // tenant to connect
 *   articles: [
 *     { documentId: "abc", publishedAt: "2025-07-04T08:57:47.000Z" },
 *     ...
 *   ]
 * }
 *
 * Remove this entire src/api/migration/ folder after running the migration.
 */
module.exports = {
  async fixPublished(ctx) {
    const { token, tenantDocumentId, articles } = ctx.request.body || {};

    // --- Auth: compare token to any valid API token ---
    const apiTokenService = strapi.plugin('users-permissions')?.service('jwt')
      || strapi.service('admin::api-token');
    // Simpler: just compare against env
    const expectedToken = process.env.STRAPI_MIGRATION_TOKEN
      || process.env.STRAPI_CLOUD_API_TOKEN
      || process.env.API_TOKEN_SALT; // fallback
    if (!token || token !== expectedToken) {
      return ctx.unauthorized('Invalid migration token.');
    }

    if (!Array.isArray(articles) || articles.length === 0) {
      return ctx.badRequest('articles array is required.');
    }

    const knex = strapi.db.connection;
    const results = { updated: 0, tenantLinked: 0, skipped: 0, errors: [] };

    // Resolve tenant numeric ID from documentId (needed for link table FK)
    let tenantNumericId = null;
    if (tenantDocumentId) {
      const tenantRow = await knex('tenants')
        .where({ document_id: tenantDocumentId })
        .select('id')
        .first();
      if (!tenantRow) {
        return ctx.badRequest(`Tenant not found: ${tenantDocumentId}`);
      }
      tenantNumericId = tenantRow.id;
    }

    // Discover the link table for tenant relation on each content type we encounter
    const linkTableCache = {};
    function getLinkTableInfo(uid) {
      if (linkTableCache[uid]) return linkTableCache[uid];
      try {
        const meta = strapi.db.metadata.get(uid);
        // attributes can be a Map or plain object depending on Strapi version
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
      if (!documentId) {
        results.skipped++;
        continue;
      }

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

        if (!publishedRow) {
          results.skipped++;
          continue;
        }

        // Update publishedAt on published row
        if (publishedAt) {
          await knex(tableName)
            .where({ id: publishedRow.id })
            .update({ published_at: publishedAt });

          // Also update the draft row so they stay in sync
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
              // Also check draft for existing order value
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
  },
};
