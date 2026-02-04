'use strict';

/**
 * One-time script to grant Editor role permission to access Advertisement Slot.
 * Run with: npm run grant:editor-ads
 * (Stop Strapi first, or run before starting Strapi)
 */
async function main() {
  const { createStrapi, compileStrapi } = require('@strapi/strapi');

  console.log('Loading Strapi...');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';
  const strapi = app;

  try {
    const conditionUid = 'plugin::api.is-same-tenant-as-user';
    const subjects = [
      'api::article.article',
      'api::advertisement-slot.advertisement-slot',
    ];
    const actions = [
      'plugin::content-manager.explorer.create',
      'plugin::content-manager.explorer.read',
      'plugin::content-manager.explorer.update',
      'plugin::content-manager.explorer.delete',
    ];
    const knex = strapi.db.connection;

    const editorRole = await strapi.db.query('admin::role').findOne({
      where: { code: 'strapi-editor' },
    });
    if (!editorRole) {
      console.error('Editor role not found.');
      await app.destroy();
      process.exit(1);
    }
    const roleId = editorRole.id;
    console.log('Found Editor role (id:', roleId, ')');

    let granted = 0;
    for (const subject of subjects) {
      for (const action of actions) {
        const rows = await knex('admin_permissions as p')
          .select('p.id', 'p.conditions')
          .innerJoin('admin_permissions_role_lnk as l', 'l.permission_id', 'p.id')
          .where('p.subject', subject)
          .andWhere('p.action', action)
          .andWhere('l.role_id', roleId)
          .orderBy('p.id', 'asc');

        if (rows.length > 0) {
          const keep = rows[0];
          const keepConditions = Array.isArray(keep.conditions)
            ? keep.conditions
            : JSON.parse(keep.conditions || '[]');
          if (!keepConditions.includes(conditionUid) || keepConditions.length !== 1) {
            await knex('admin_permissions').where({ id: keep.id }).update({
              conditions: JSON.stringify([conditionUid]),
            });
            console.log('Updated conditions for', action, 'on', subject);
          }
          if (rows.length > 1) {
            const duplicateIds = rows.slice(1).map((row) => row.id);
            await knex('admin_permissions_role_lnk').whereIn('permission_id', duplicateIds).del();
            await knex('admin_permissions').whereIn('id', duplicateIds).del();
            console.log('Removed duplicates for', action, 'on', subject);
          }
          continue;
        }

        const created = await strapi.db.query('admin::permission').create({
          data: {
            action,
            subject,
            conditions: [conditionUid],
          },
          select: ['id'],
        });

        const [{ count }] = await knex('admin_permissions_role_lnk')
          .where({ role_id: roleId })
          .count({ count: '*' });
        const permissionOrd = Number(count) + 1;

        await knex('admin_permissions_role_lnk').insert({
          permission_id: created.id,
          role_id: roleId,
          permission_ord: permissionOrd,
        });
        console.log('Granted:', action, 'on', subject);
        granted++;
      }
    }
    if (granted > 0) {
      console.log('Success! Granted', granted, 'permission(s).');
      console.log('Restart Strapi (npm run develop) and log in as Editor to verify Article and Advertisement Slot visibility.');
    } else {
      console.log('Advertisement Slot permissions already configured for Editor role.');
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
