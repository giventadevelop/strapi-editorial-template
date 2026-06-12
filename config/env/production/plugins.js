'use strict';

const localUpload = require('../../plugins');

// Strapi Cloud production upload provider.
// Default to local until valid AWS credentials are configured on Cloud (UPLOAD_PROVIDER=aws-s3).
// Cloud /api/upload returns HTTP 500 when aws-s3 is used with missing/invalid AWS_* env vars.
module.exports = ({ env }) => {
  const provider = env('UPLOAD_PROVIDER', 'local');
  if (provider === 'local') {
    return localUpload({ env });
  }

  return {
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
              ACL: env('AWS_ACL') && env('AWS_ACL') !== 'none' ? env('AWS_ACL') : undefined,
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
        sizeLimit: 250 * 1024 * 1024,
      },
    },
  };
};
