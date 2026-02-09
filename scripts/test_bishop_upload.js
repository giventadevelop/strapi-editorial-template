'use strict';

/**
 * Runs only the bishop-upload part of the directory import and verifies that
 * images are linked. Use to debug batch upload when manual dashboard upload works
 * but batch-imported bishops have no image.
 *
 * Prerequisites: same as data_import_seed_directory_mosc_in.js
 *   - STRAPI_DATA_IMPORT_PROJECT_CLONE_DIR (or CLONE_DIR) pointing to directory clone
 *   - TENANT_ID (optional, default directory_mosc_001)
 *   - Clone should contain bishops/ HTML (or set STRAPI_DIRECTORY_FETCH_MISSING_PAGES=1)
 *
 * Run: npm run test:bishop_upload
 *
 * Output: For each of the first 5 bishops that have an imagePath, logs:
 *   - imagePath, upload result (documentId or null), and after create whether
 *     the bishop document has image linked (findOne with populate: ['image']).
 */

process.env.TEST_BISHOP_UPLOAD_ONLY = '1';
require('./data_import_seed_directory_mosc_in.js');
