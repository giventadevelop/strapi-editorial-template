'use strict';

/**
 * Grant Editor role CM permissions for all Directory + Editorial types on Strapi Cloud.
 * Same scope as npm run grant:editor-directory (local), including Training and Holy Synod.
 *
 * Usage: npm run grant:editor-directory-on-cloud
 */

const { grantEditorPermissionsOnCloud } = require('./lib/cloud-grant-editor-permissions');

async function main() {
  const body = await grantEditorPermissionsOnCloud({ allDirectory: true });
  console.log('Success:', JSON.stringify(body, null, 2));
  console.log('Editors should log out and back in to see all Directory types in Content Manager.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
