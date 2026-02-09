module.exports = [
  'strapi::logger',
  'strapi::errors',
  'strapi::security',
  'strapi::cors',
  'strapi::poweredBy',
  'strapi::query',
  {
    name: 'strapi::body',
    config: {
      formLimit: '256mb',
      jsonLimit: '256mb',
      textLimit: '256mb',
      formidable: {
        maxFileSize: 250 * 1024 * 1024, // 250 MB — multipart uploads (Media Library)
      },
    },
  },
  'global::request-context', // store request ctx for tenant injection in lifecycles
  'global::content-manager-article-relation', // Editor: request more articles in list/relation picker
  'global::content-manager-hide-tenant', // hide tenant/views/isFeatured for Editor UI
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
];
