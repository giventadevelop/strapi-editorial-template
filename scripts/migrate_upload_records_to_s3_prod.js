'use strict';

// Run the S3 migration with prod prefix (strapi-editorial-media/prod)
process.env.S3_UPLOAD_PREFIX = 'strapi-editorial-media/prod';
require('./migrate_upload_records_to_s3.js');
