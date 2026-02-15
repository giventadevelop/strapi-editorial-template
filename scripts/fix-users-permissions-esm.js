'use strict';

/**
 * Workaround: @strapi/plugin-users-permissions dist/admin/index.mjs imports
 * ./package.json.mjs but the published package only contains package.json.js.
 * This script creates the missing ESM file so the admin build can resolve it.
 * Run automatically after npm install via postinstall.
 */
const path = require('path');
const fs = require('fs');

const targetDir = path.join(
  __dirname,
  '..',
  'node_modules',
  '@strapi',
  'plugin-users-permissions',
  'dist',
  'admin'
);
const targetFile = path.join(targetDir, 'package.json.mjs');

const content = `const name = "@strapi/plugin-users-permissions";
const strapi = {
  displayName: "Roles & Permissions",
  name: "users-permissions",
  description: "Protect your API with a full authentication process based on JWT. This plugin comes also with an ACL strategy that allows you to manage the permissions between the groups of users.",
  required: true,
  kind: "plugin",
};
export { name, strapi };
`;

try {
  if (fs.existsSync(targetDir)) {
    fs.writeFileSync(targetFile, content, 'utf8');
    console.log('Applied fix: created package.json.mjs for @strapi/plugin-users-permissions');
  }
} catch (err) {
  console.warn('Could not apply users-permissions ESM fix:', err.message);
}
