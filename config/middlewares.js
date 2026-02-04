module.exports = [
  'strapi::logger',
  'strapi::errors',
  'strapi::security',
  'strapi::cors',
  'strapi::poweredBy',
  'strapi::query',
  'strapi::body',
  'global::request-context', // store request ctx for tenant injection in lifecycles
  'global::content-manager-hide-tenant', // hide tenant/views/isFeatured for Editor UI
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
];
