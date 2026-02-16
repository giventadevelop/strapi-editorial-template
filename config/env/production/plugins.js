'use strict';

// S3 upload for production (Strapi Cloud): eventapp-media-bucket, prefix strapi-editorial-media/prod/
module.exports = ({ env }) => ({
  upload: {
    config: {
      provider: 'aws-s3',
      providerOptions: {
        rootPath: 'strapi-editorial-media/prod',
        s3Options: {
          credentials: {
            accessKeyId: env('AWS_ACCESS_KEY_ID'),
            secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
          },
          region: env('AWS_REGION', 'us-east-2'),
          params: {
            ACL: env('AWS_ACL', 'public-read'),
            Bucket: env('AWS_S3_BUCKET_NAME', 'eventapp-media-bucket'),
          },
        },
      },
      actionOptions: {
        upload: {},
        uploadStream: {},
        delete: {},
      },
      security: {
        allowedTypes: ['image/*', 'video/*', 'audio/*', 'application/pdf', 'application/*'],
        deniedTypes: ['application/x-sh', 'application/x-executable', 'application/x-dosexec'],
      },
      sizeLimit: 250 * 1024 * 1024, // 250 MB
    },
  },
});
