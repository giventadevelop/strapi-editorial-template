'use strict';

/**
 * Grant Editor role Content Manager permissions (create, read, update, delete)
 * for all Directory and tenant-scoped Editorial types so Editors can see and
 * edit Parishes, Dioceses, etc. Run if Editors only see content
 * as Super Admin or permissions were not applied on first run.
 *
 * Run with Strapi stopped: node scripts/grant-editor-directory-permissions.js
 * Or: npm run grant:editor-directory
 *
 * Also ensure each Editor user has an Editor Tenant Assignment (Content Manager
 * → Editor Tenant Assignment) so they see their tenant's data only.
 */

try {
  require('dotenv').config();
} catch (_) {}

const SUBJECTS = [
  'api::article.article',
  'api::advertisement-slot.advertisement-slot',
  'api::flash-news-item.flash-news-item',
  'api::directory-home.directory-home',
  'api::bishop.bishop',
  'api::catholicos.catholicos',
  'api::diocesan-bishop.diocesan-bishop',
  'api::retired-bishop.retired-bishop',
  'api::diocese.diocese',
  'api::parish.parish',
  'api::priest.priest',
  'api::directory-entry.directory-entry',
  'api::institution.institution',
  'api::church-dignitary.church-dignitary',
  'api::working-committee.working-committee',
  'api::managing-committee.managing-committee',
  'api::spiritual-organisation.spiritual-organisation',
  'api::pilgrim-centre.pilgrim-centre',
  'api::seminary.seminary',
];

const ACTIONS = [
  'plugin::content-manager.explorer.create',
  'plugin::content-manager.explorer.read',
  'plugin::content-manager.explorer.update',
  'plugin::content-manager.explorer.delete',
];

async function main() {
  const { createStrapi, compileStrapi } = require('@strapi/strapi');

  console.log('Loading Strapi...');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';
  const strapi = app;

  try {
    const knex = strapi.db.connection;
    const editorRole = await strapi.db.query('admin::role').findOne({
      where: { code: 'strapi-editor' },
    });
    if (!editorRole) {
      console.error('Editor role not found. Create an Editor role in Settings → Administration Panel → Roles first.');
      await app.destroy();
      process.exit(1);
    }
    const roleId = editorRole.id;
    console.log('Editor role id:', roleId);
    console.log('Ensuring permissions for', SUBJECTS.length, 'content types ×', ACTIONS.length, 'actions...');

    let created = 0;
    let updated = 0;
    const targetConditions = [];

    for (const subject of SUBJECTS) {
      for (const action of ACTIONS) {
        const rows = await knex('admin_permissions as p')
          .select('p.id', 'p.document_id', 'p.conditions')
          .innerJoin('admin_permissions_role_lnk as l', 'l.permission_id', 'p.id')
          .where('p.action', action)
          .andWhere('p.subject', subject)
          .andWhere('l.role_id', roleId)
          .orderBy('p.id', 'asc');

        if (rows.length > 0) {
          const keep = rows[0];
          const currentConditions = Array.isArray(keep.conditions)
            ? keep.conditions
            : JSON.parse(keep.conditions || '[]');
          if (JSON.stringify(currentConditions) !== JSON.stringify(targetConditions)) {
            await knex('admin_permissions')
              .where({ id: keep.id })
              .update({ conditions: JSON.stringify(targetConditions) });
            updated++;
            console.log('  Updated:', action, '→', subject);
          }
          if (rows.length > 1) {
            const duplicateIds = rows.slice(1).map((r) => r.id);
            await knex('admin_permissions_role_lnk').whereIn('permission_id', duplicateIds).del();
            await knex('admin_permissions').whereIn('id', duplicateIds).del();
            console.log('  Removed duplicate permission:', action, subject);
          }
          continue;
        }

        const createdPerm = await strapi.db.query('admin::permission').create({
          data: {
            action,
            subject,
            conditions: targetConditions,
          },
          select: ['id', 'documentId'],
        });
        const permissionId = createdPerm.id;

        const [{ count }] = await knex('admin_permissions_role_lnk')
          .where({ role_id: roleId })
          .count({ count: '*' });
        const permissionOrd = Number(count) + 1;

        await knex('admin_permissions_role_lnk').insert({
          permission_id: permissionId,
          role_id: roleId,
          permission_ord: permissionOrd,
        });
        await knex('admin_permissions')
          .where({ id: permissionId })
          .update({ document_id: createdPerm.documentId ?? permissionId });

        created++;
        console.log('  Granted:', action, '→', subject);
      }
    }

    console.log('\nDone. Created', created, 'permission(s), updated', updated);
    if (created > 0 || updated > 0) {
      console.log('Restart Strapi (npm run develop) and log in as an Editor. Ensure the Editor has an');
      console.log('Editor Tenant Assignment (Content Manager → Editor Tenant Assignment) so they see their tenant\'s data.');
    } else {
      console.log('Editor already has the expected permissions for Directory and Editorial types.');
    }
  } catch (err) {
    console.error('Error:', err.message);
    throw err;
  } finally {
    await app.destroy();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
