'use strict';

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/migration/fix-published',
      handler: 'migration.fixPublished',
      config: {
        auth: false,
      },
    },
  ],
};
