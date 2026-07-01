'use strict';

const EDITOR_DIRECTORY_ACTIONS = [
  'plugin::content-manager.explorer.create',
  'plugin::content-manager.explorer.read',
  'plugin::content-manager.explorer.update',
  'plugin::content-manager.explorer.delete',
];

const TRAINING_PROGRAM_SUBJECT = 'api::training-program.training-program';

/** Same list as grant-editor-directory-permissions.js and bootstrap ensureEditorTenantScopedPermissions. */
const EDITOR_DIRECTORY_SUBJECTS = [
  'api::article.article',
  'api::advertisement-slot.advertisement-slot',
  'api::flash-news-item.flash-news-item',
  'api::directory-home.directory-home',
  'api::bishop.bishop',
  'api::catholicos.catholicos',
  'api::current-catholicos.current-catholicos',
  'api::diocesan-bishop.diocesan-bishop',
  'api::holy-synod-member.holy-synod-member',
  'api::ecumenical-article.ecumenical-article',
  'api::saint-entry.saint-entry',
  'api::catholicate-entry.catholicate-entry',
  'api::theological-seminary.theological-seminary',
  'api::training-program.training-program',
  'api::publication-entry.publication-entry',
  'api::retired-bishop.retired-bishop',
  'api::diocese.diocese',
  'api::parish.parish',
  'api::priest.priest',
  'api::directory-entry.directory-entry',
  'api::liturgy-day.liturgy-day',
  'api::institution.institution',
  'api::church-dignitary.church-dignitary',
  'api::working-committee.working-committee',
  'api::managing-committee.managing-committee',
  'api::spiritual-organisation.spiritual-organisation',
  'api::pilgrim-centre.pilgrim-centre',
  'api::seminary.seminary',
  'api::kalpana-page.kalpana-page',
  'api::kalpana-edition.kalpana-edition',
  'api::kalpana-document.kalpana-document',
];

function propertiesForAction(action, fieldNames) {
  if (action === 'plugin::content-manager.explorer.delete') return {};
  if (
    action === 'plugin::content-manager.explorer.create' ||
    action === 'plugin::content-manager.explorer.read' ||
    action === 'plugin::content-manager.explorer.update'
  ) {
    return { fields: fieldNames };
  }
  return {};
}

function parseProperties(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw || '{}');
  } catch (_) {
    return {};
  }
}

/**
 * Grant Editor role Content Manager permissions for the given content-type subjects.
 * Idempotent: creates missing permissions and updates conditions/properties when needed.
 */
async function grantEditorContentManagerPermissions(strapi, subjects, options = {}) {
  const targetConditions = options.conditions ?? [];
  const knex = strapi.db.connection;
  const editorRole = await strapi.db.query('admin::role').findOne({
    where: { code: 'strapi-editor' },
  });
  if (!editorRole) {
    throw new Error('Editor role not found (code: strapi-editor).');
  }

  const roleId = editorRole.id;
  let created = 0;
  let updated = 0;

  for (const subject of subjects) {
    const ct = strapi.contentTypes[subject];
    if (!ct) {
      throw new Error(`Unknown content type: ${subject}`);
    }
    const fieldNames = ct.attributes ? Object.keys(ct.attributes) : [];

    for (const action of EDITOR_DIRECTORY_ACTIONS) {
      const actionProperties = propertiesForAction(action, fieldNames);
      const rows = await knex('admin_permissions as p')
        .select('p.id', 'p.document_id', 'p.conditions', 'p.properties')
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
        const currentProperties = parseProperties(keep.properties);
        const needsConditions =
          JSON.stringify(currentConditions) !== JSON.stringify(targetConditions);
        const needsProperties =
          JSON.stringify(currentProperties) !== JSON.stringify(actionProperties);
        if (needsConditions || needsProperties) {
          await knex('admin_permissions')
            .where({ id: keep.id })
            .update({
              conditions: JSON.stringify(targetConditions),
              properties: JSON.stringify(actionProperties),
            });
          updated++;
        }
        if (rows.length > 1) {
          const duplicateIds = rows.slice(1).map((row) => row.id);
          await knex('admin_permissions_role_lnk').whereIn('permission_id', duplicateIds).del();
          await knex('admin_permissions').whereIn('id', duplicateIds).del();
        }
        continue;
      }

      const createdPerm = await strapi.db.query('admin::permission').create({
        data: {
          action,
          subject,
          conditions: targetConditions,
          properties: actionProperties,
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
    }
  }

  return { created, updated, subjects };
}

module.exports = {
  EDITOR_DIRECTORY_ACTIONS,
  EDITOR_DIRECTORY_SUBJECTS,
  TRAINING_PROGRAM_SUBJECT,
  grantEditorContentManagerPermissions,
};
