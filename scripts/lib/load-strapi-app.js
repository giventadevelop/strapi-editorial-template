'use strict';

/**
 * Load embedded Strapi for scripts (Strapi dev server should be stopped).
 */
async function loadStrapiApp(options = {}) {
  const { logLevel = 'error' } = options;
  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = logLevel;
  return app;
}

module.exports = { loadStrapiApp };
