'use strict';

/**
 * Mutate the content-manager configuration response for Article so the list view
 * always receives "publishedAt" in layouts.list (Published at column).
 * Runs after the route handler so we modify the actual response body.
 */
module.exports = () => async (ctx, next) => {
  await next();
  if (ctx.method !== 'GET') return;
  // Match path with or without leading slash; admin plugin may use different base
  const path = (ctx.path || ctx.url || '').replace(/^\/+/, '');
  const isConfig = path.includes('content-types/') && path.endsWith('/configuration');
  if (!isConfig) return;
  const ct = ctx.body?.data?.contentType;
  if (!ct || ct.uid !== 'api::article.article') return;
  if (!ct.layouts) return;
  const list = ct.layouts.list;
  if (!Array.isArray(list) || list.includes('publishedAt')) return;
  ct.layouts.list = [...list, 'publishedAt'];
  ct.metadatas = ct.metadatas || {};
  ct.metadatas.publishedAt = {
    ...ct.metadatas.publishedAt,
    list: {
      label: 'publishedAt',
      searchable: false,
      sortable: true,
      ...(ct.metadatas.publishedAt && ct.metadatas.publishedAt.list),
    },
  };
  strapi.log.info('Article list config: injected publishedAt into layouts.list');
};
