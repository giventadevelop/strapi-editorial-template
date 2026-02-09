module.exports = ({ env }) => ({
  upload: {
    config: {
      provider: 'local',
      sizeLimit: 250 * 1024 * 1024, // 250 MB (must match body middleware below)
      // Required in Strapi 5: without this, you get "No upload security configuration found"
      // and dashboard uploads can hang or fail.
      security: {
        allowedTypes: ['image/*', 'video/*', 'audio/*', 'application/pdf', 'application/*'],
        deniedTypes: ['application/x-sh', 'application/x-executable', 'application/x-dosexec'],
      },
    },
  },
});
