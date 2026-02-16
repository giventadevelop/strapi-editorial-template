module.exports = [
  'strapi::logger',
  'strapi::errors',
  {
    name: 'strapi::security',
    config: {
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'connect-src': ["'self'", 'https:'],
          'img-src': [
            "'self'", 'data:', 'blob:', 'market-assets.strapi.io',
            '*.s3.*.amazonaws.com', '*.s3.amazonaws.com', 'eventapp-media-bucket.s3.us-east-2.amazonaws.com',
          ],
          'media-src': [
            "'self'", 'data:', 'blob:', 'market-assets.strapi.io',
            '*.s3.*.amazonaws.com', '*.s3.amazonaws.com', 'eventapp-media-bucket.s3.us-east-2.amazonaws.com',
          ],
          upgradeInsecureRequests: null,
        },
      },
    },
  },
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
  'global::content-manager-article-published-at', // inject publishedAt into Article list configuration response
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
];
