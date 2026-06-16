'use strict';

/**
 * Grant Editor role Content Manager permissions for Directory – Training on Strapi Cloud.
 * Uses POST /api/migration/fix-published with grantEditorPermissions (same pattern as Holy Synod local grant).
 *
 * Env: STRAPI_CLOUD_URL, STRAPI_CLOUD_API_TOKEN
 * Usage: npm run grant:editor-training-on-cloud
 */

const { TRAINING_PROGRAM_SUBJECT } = require('../src/utils/editor-directory-permissions');
const { grantEditorPermissionsOnCloud } = require('./lib/cloud-grant-editor-permissions');

async function main() {
  const body = await grantEditorPermissionsOnCloud({
    subjects: [TRAINING_PROGRAM_SUBJECT],
  });
  console.log('Success:', JSON.stringify(body, null, 2));
  console.log('Editors should log out and back in to see Directory – Training in Content Manager.');
}

main().catch((err) => {
  console.error(err.message || err);
  if (err.status === 400 && err.body?.error?.message?.includes('articles array')) {
    console.error(
      'Cloud is running an older build. Deploy latest code (fix-published grantEditorPermissions), then rerun.'
    );
  }
  process.exit(1);
});
