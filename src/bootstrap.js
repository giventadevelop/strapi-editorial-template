'use strict';

const fs = require('fs-extra');
const path = require('path');
const mime = require('mime-types');
const { categories, authors, articles, global, about } = require('../data/data.json');

async function seedExampleApp() {
  const shouldImportSeedData = await isFirstRun();

  if (shouldImportSeedData) {
    try {
      console.log('Setting up the template...');
      await importSeedData();
      console.log('Ready to go');
    } catch (error) {
      console.log('Could not import seed data');
      console.error(error);
    }
  } else {
    console.log(
      'Seed data has already been imported. We cannot reimport unless you clear your database first.'
    );
  }
}

async function isFirstRun() {
  const pluginStore = strapi.store({
    environment: strapi.config.environment,
    type: 'type',
    name: 'setup',
  });
  const initHasRun = await pluginStore.get({ key: 'initHasRun' });
  await pluginStore.set({ key: 'initHasRun', value: true });
  return !initHasRun;
}

async function setPublicPermissions(newPermissions) {
  // Find the ID of the public role
  const publicRole = await strapi.query('plugin::users-permissions.role').findOne({
    where: {
      type: 'public',
    },
  });

  // Create the new permissions and link them to the public role
  const allPermissionsToCreate = [];
  Object.keys(newPermissions).map((controller) => {
    const actions = newPermissions[controller];
    const permissionsToCreate = actions.map((action) => {
      return strapi.query('plugin::users-permissions.permission').create({
        data: {
          action: `api::${controller}.${controller}.${action}`,
          role: publicRole.id,
        },
      });
    });
    allPermissionsToCreate.push(...permissionsToCreate);
  });
  await Promise.all(allPermissionsToCreate);
}

function getFileSizeInBytes(filePath) {
  const stats = fs.statSync(filePath);
  const fileSizeInBytes = stats['size'];
  return fileSizeInBytes;
}

function getFileData(fileName) {
  const filePath = path.join('data', 'uploads', fileName);
  // Parse the file metadata
  const size = getFileSizeInBytes(filePath);
  const ext = fileName.split('.').pop();
  const mimeType = mime.lookup(ext || '') || '';

  return {
    filepath: filePath,
    originalFileName: fileName,
    size,
    mimetype: mimeType,
  };
}

async function uploadFile(file, name) {
  return strapi
    .plugin('upload')
    .service('upload')
    .upload({
      files: file,
      data: {
        fileInfo: {
          alternativeText: `An image uploaded to Strapi called ${name}`,
          caption: name,
          name,
        },
      },
    });
}

// Create an entry and attach files if there are any
async function createEntry({ model, entry }) {
  try {
    // Actually create the entry in Strapi
    await strapi.documents(`api::${model}.${model}`).create({
      data: entry,
    });
  } catch (error) {
    console.error({ model, entry, error });
  }
}

async function checkFileExistsBeforeUpload(files) {
  const existingFiles = [];
  const uploadedFiles = [];
  const filesCopy = [...files];

  for (const fileName of filesCopy) {
    // Check if the file already exists in Strapi
    const fileWhereName = await strapi.query('plugin::upload.file').findOne({
      where: {
        name: fileName.replace(/\..*$/, ''),
      },
    });

    if (fileWhereName) {
      // File exists, don't upload it
      existingFiles.push(fileWhereName);
    } else {
      // File doesn't exist, upload it
      const fileData = getFileData(fileName);
      const fileNameNoExtension = fileName.split('.').shift();
      const [file] = await uploadFile(fileData, fileNameNoExtension);
      uploadedFiles.push(file);
    }
  }
  const allFiles = [...existingFiles, ...uploadedFiles];
  // If only one file then return only that file
  return allFiles.length === 1 ? allFiles[0] : allFiles;
}

async function updateBlocks(blocks) {
  const updatedBlocks = [];
  for (const block of blocks) {
    if (block.__component === 'shared.media') {
      const uploadedFiles = await checkFileExistsBeforeUpload([block.file]);
      // Copy the block to not mutate directly
      const blockCopy = { ...block };
      // Replace the file name on the block with the actual file
      blockCopy.file = uploadedFiles;
      updatedBlocks.push(blockCopy);
    } else if (block.__component === 'shared.slider') {
      // Get files already uploaded to Strapi or upload new files
      const existingAndUploadedFiles = await checkFileExistsBeforeUpload(block.files);
      // Copy the block to not mutate directly
      const blockCopy = { ...block };
      // Replace the file names on the block with the actual files
      blockCopy.files = existingAndUploadedFiles;
      // Push the updated block
      updatedBlocks.push(blockCopy);
    } else {
      // Just push the block as is
      updatedBlocks.push(block);
    }
  }

  return updatedBlocks;
}

async function importArticles() {
  for (const article of articles) {
    const cover = await checkFileExistsBeforeUpload([`${article.slug}.jpg`]);
    const updatedBlocks = await updateBlocks(article.blocks);

    await createEntry({
      model: 'article',
      entry: {
        ...article,
        cover,
        blocks: updatedBlocks,
        // Make sure it's not a draft
        publishedAt: Date.now(),
      },
    });
  }
}

async function importGlobal() {
  const favicon = await checkFileExistsBeforeUpload(['favicon.png']);
  const shareImage = await checkFileExistsBeforeUpload(['default-image.png']);
  return createEntry({
    model: 'global',
    entry: {
      ...global,
      favicon,
      // Make sure it's not a draft
      publishedAt: Date.now(),
      defaultSeo: {
        ...global.defaultSeo,
        shareImage,
      },
    },
  });
}

async function importAbout() {
  const updatedBlocks = await updateBlocks(about.blocks);

  await createEntry({
    model: 'about',
    entry: {
      ...about,
      blocks: updatedBlocks,
      // Make sure it's not a draft
      publishedAt: Date.now(),
    },
  });
}

async function importCategories() {
  for (const category of categories) {
    await createEntry({ model: 'category', entry: category });
  }
}

async function importAuthors() {
  for (const author of authors) {
    const avatar = await checkFileExistsBeforeUpload([author.avatar]);

    await createEntry({
      model: 'author',
      entry: {
        ...author,
        avatar,
      },
    });
  }
}

async function importSeedData() {
  // Allow read of application content types
  await setPublicPermissions({
    article: ['find', 'findOne'],
    category: ['find', 'findOne'],
    author: ['find', 'findOne'],
    global: ['find', 'findOne'],
    about: ['find', 'findOne'],
  });

  // Create all entries
  await importCategories();
  await importAuthors();
  await importArticles();
  await importGlobal();
  await importAbout();
}

async function main() {
  const { createStrapi, compileStrapi } = require('@strapi/strapi');

  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();

  app.log.level = 'error';

  await seedExampleApp();
  await app.destroy();

  process.exit(0);
}


const TENANT_CONDITION_UID = 'plugin::api.is-same-tenant-as-user';
let tenantConditionId = TENANT_CONDITION_UID;

async function registerTenantRBACConditions() {
  // Custom RBAC condition: filter content by user's assigned tenant
  const conditionProvider = strapi.admin?.services?.permission?.conditionProvider;
  if (!conditionProvider) {
    strapi.log.warn('Admin condition provider unavailable; tenant RBAC condition not registered.');
    return;
  }

  if (!conditionProvider.has(TENANT_CONDITION_UID)) {
    await conditionProvider.register({
      displayName: 'Is same tenant as user',
      name: 'is-same-tenant-as-user',
      plugin: 'api',
      category: 'Multi-tenant',
      async handler(user) {
        if (!user) return { id: { $eq: null } };
        let email = user.email;
        if (!email && user.id) {
          const adminUser = await strapi.db.query('admin::user').findOne({
            where: { id: user.id },
            select: ['email'],
          });
          email = adminUser?.email;
        }
        if (!email) return { id: { $eq: null } };
        const emailLower = String(email).toLowerCase();
        const mappings = await strapi.db.query('api::editor-tenant.editor-tenant').findMany({
          where: {},
          populate: { tenant: true },
        });
        const mapping = mappings.find(
          (m) => (m.adminUserEmail || '').toLowerCase() === emailLower
        );
        if (!mapping?.tenant) {
          return { id: { $eq: null } };
        }
        const tenantDoc = mapping.tenant;
        const tenantDocumentId = tenantDoc.documentId ?? tenantDoc.document_id;
        const tenantId = tenantDoc.id != null ? Number(tenantDoc.id) : null;
        if (tenantId == null && !tenantDocumentId) return { id: { $eq: null } };
        // Match tenant: stored as numeric FK. Return simple equality (tenant: id) for findOne/findMany.
        if (tenantId != null) {
          return { tenant: tenantId };
        }
        if (tenantDocumentId) {
          return {
            $or: [
              { tenant: { documentId: { $eq: tenantDocumentId } } },
              { tenant: { $eq: tenantDocumentId } }
            ]
          };
        }
        return { id: { $eq: null } };
      },
    });
  }

  tenantConditionId = conditionProvider.has(TENANT_CONDITION_UID)
    ? TENANT_CONDITION_UID
    : conditionProvider.keys().find((key) => key.endsWith('is-same-tenant-as-user')) ?? TENANT_CONDITION_UID;
}

/**
 * Ensure Editor role has tenant-scoped permissions for key collection types.
 * New content types are not auto-granted to roles; Editors need explicit permissions.
 */
async function ensureEditorTenantScopedPermissions() {
  const subjects = [
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
    'api::church.church',
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
  const actions = [
    'plugin::content-manager.explorer.create',
    'plugin::content-manager.explorer.read',
    'plugin::content-manager.explorer.update',
    'plugin::content-manager.explorer.delete',
  ];
  const targetConditions = [];

  try {
    const knex = strapi.db.connection;
    // Strapi 5 uses code 'strapi-editor' for the Editor role
    const editorRole = await strapi.db.query('admin::role').findOne({
      where: { code: 'strapi-editor' },
    });
    if (!editorRole) {
      strapi.log.warn('Editor role not found, skipping tenant permission grant');
      return;
    }

    const roleId = editorRole.id;

    for (const subject of subjects) {
      for (const action of actions) {
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
            strapi.log.info(`Updated Editor permission conditions: ${action} on ${subject}`);
          }

          if (rows.length > 1) {
            const duplicateIds = rows.slice(1).map((row) => row.id);
            if (duplicateIds.length > 0) {
              await knex('admin_permissions_role_lnk').whereIn('permission_id', duplicateIds).del();
              await knex('admin_permissions').whereIn('id', duplicateIds).del();
              strapi.log.info(`Removed duplicate Editor permissions: ${action} on ${subject}`);
            }
          }
          continue;
        }

        const created = await strapi.db.query('admin::permission').create({
          data: {
            action,
            subject,
            conditions: targetConditions,
          },
          select: ['id', 'documentId'],
        });
        const permissionId = created.id;

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
          .update({ document_id: created.documentId ?? permissionId });

        strapi.log.info(`Granted Editor permission: ${action} on ${subject}`);
      }
    }
  } catch (err) {
    strapi.log.error('ensureEditorTenantScopedPermissions failed:', err.message);
  }
}

/**
 * Hide tenant field in Content Manager edit view for tenant-scoped content types.
 * Schema pluginOptions.content-manager.visible: false is the primary mechanism; this tries to
 * update stored layout so the tenant field is not shown (e.g. if layout was customized).
 */
async function hideTenantFieldInContentManagerLayout() {
  const contentTypes = [
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
    'api::church.church',
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
  try {
    const store = strapi.store({ type: 'plugin', name: 'content-manager' });
    const config = (await store.get({ key: 'configuration' })) || {};
    const contentTypesConfig = config.content_types || {};
    let updated = false;
    for (const uid of contentTypes) {
      const ct = contentTypesConfig[uid];
      if (!ct) continue;
      const edit = ct.edit || {};
      const layouts = edit.layouts || edit.layout;
      if (layouts && Array.isArray(layouts)) {
        for (const row of layouts) {
          if (Array.isArray(row)) {
            const idx = row.findIndex((cell) => cell?.name === 'tenant' || cell?.field === 'tenant');
            if (idx !== -1) {
              row.splice(idx, 1);
              updated = true;
            }
          }
        }
      }
    }
    if (updated) {
      await store.set({ key: 'configuration', value: config });
      strapi.log.info('Content Manager: tenant field removed from edit layout for tenant-scoped types');
    }
  } catch (err) {
    strapi.log.warn('Could not update Content Manager layout for tenant field:', err.message);
  }
}

/**
 * Enforce tenant scoping at Document Service level for Editor role.
 * This avoids 403s on single-document reads while still scoping data by tenant.
 */
async function registerTenantDocumentMiddleware() {
  const tenantScopedUids = [
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
    'api::church.church',
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

  async function getAdminUserIdFromContext() {
    const requestContext = require('./utils/request-context');
    const ctx = requestContext.get();
    if (!ctx) return null;
    const fromState = ctx.state?.user?.id ?? ctx.state?.admin?.id;
    if (fromState != null) return fromState;
    const authz = ctx.request?.header?.authorization || ctx.request?.headers?.authorization;
    if (!authz || typeof authz !== 'string') return null;
    const parts = authz.trim().split(/\s+/);
    if (parts[0].toLowerCase() !== 'bearer' || !parts[1]) return null;
    const manager = strapi.sessionManager;
    if (!manager) return null;
    try {
      const result = manager('admin').validateAccessToken(parts[1]);
      if (!result?.isValid || result?.payload?.userId == null) return null;
      const raw = result.payload.userId;
      const num = Number(raw);
      return Number.isFinite(num) && String(num) === String(raw) ? num : raw;
    } catch {
      return null;
    }
  }

  async function resolveEditorTenant() {
    const currentAdminUserId = await getAdminUserIdFromContext();
    if (currentAdminUserId == null) return null;

    const adminUser = await strapi.db.query('admin::user').findOne({
      where: { id: currentAdminUserId },
      populate: { roles: true },
      select: ['email'],
    });
    if (!adminUser?.email) return null;
    const isEditor = (adminUser.roles || []).some((r) => r.code === 'strapi-editor');
    if (!isEditor) return null;

    const mappings = await strapi.db.query('api::editor-tenant.editor-tenant').findMany({
      where: {},
      populate: { tenant: true },
    });
    const mapping = mappings.find(
      (m) => (m.adminUserEmail || '').toLowerCase() === String(adminUser.email).toLowerCase()
    );
    const tenant = mapping?.tenant;
    if (!tenant) return null;
    return { id: tenant.id, documentId: tenant.documentId ?? tenant.document_id };
  }

  strapi.documents.use(async (context, next) => {
    const { uid, action, params } = context;
    if (!tenantScopedUids.includes(uid)) {
      return next();
    }

    const tenant = await resolveEditorTenant();
    if (!tenant?.id && !tenant?.documentId) {
      return next();
    }

    if (action === 'findMany') {
      // Strapi 5 may store relation by id or documentId; filter so either matches
      const tenantFilter =
        tenant.documentId != null
          ? { $or: [{ tenant: tenant.id }, { tenant: { documentId: tenant.documentId } }] }
          : { tenant: tenant.id };
      context.params = {
        ...params,
        filters: params?.filters ? { $and: [params.filters, tenantFilter] } : tenantFilter,
      };
      return next();
    }

    const result = await next();

    if (action === 'findOne' || action === 'update' || action === 'delete' || action === 'publish' || action === 'unpublish') {
      const tenantValue = result?.tenant;
      const tenantId =
        typeof tenantValue === 'object'
          ? tenantValue?.id ?? tenantValue?.documentId
          : tenantValue;
      if (tenantId != null && tenantId !== tenant.id && tenantId !== tenant.documentId) {
        const error = new Error('Forbidden');
        error.status = 403;
        throw error;
      }
    }

    return result;
  });
}

/**
 * Ensure homepage, sidebar-promotional-block, advertisement-slot have public find permission
 * so the Content API returns data (avoids 404 for single types).
 */
async function ensureContentApiPublicPermissions() {
  const publicRole = await strapi.query('plugin::users-permissions.role').findOne({
    where: { type: 'public' },
  });
  if (!publicRole) return;
  const toEnsure = [
    { controller: 'homepage', actions: ['find'] },
    { controller: 'sidebar-promotional-block', actions: ['find'] },
    { controller: 'advertisement-slot', actions: ['find', 'findOne'] },
    { controller: 'flash-news-item', actions: ['find', 'findOne'] },
    { controller: 'directory-home', actions: ['find'] },
    { controller: 'bishop', actions: ['find', 'findOne'] },
    { controller: 'diocese', actions: ['find', 'findOne'] },
    { controller: 'parish', actions: ['find', 'findOne'] },
    { controller: 'church', actions: ['find', 'findOne'] },
    { controller: 'priest', actions: ['find', 'findOne'] },
    { controller: 'directory-entry', actions: ['find', 'findOne'] },
  ];
  for (const { controller, actions } of toEnsure) {
    for (const action of actions) {
      const actionId = `api::${controller}.${controller}.${action}`;
      const existing = await strapi.query('plugin::users-permissions.permission').findOne({
        where: { action: actionId, role: publicRole.id },
      });
      if (!existing) {
        await strapi.query('plugin::users-permissions.permission').create({
          data: { action: actionId, role: publicRole.id },
        });
        strapi.log.info(`Content API: granted public ${action} for ${controller}`);
      }
    }
  }
}

/**
 * Move title field to the top of Flash News Item edit layout.
 * Layout is stored in content-manager configuration; reorder so title appears first.
 */
async function ensureFlashNewsItemTitleFirst() {
  const uid = 'api::flash-news-item.flash-news-item';
  try {
    const store = strapi.store({ type: 'plugin', name: 'content-manager' });
    const config = (await store.get({ key: 'configuration' })) || {};
    const contentTypesConfig = config.content_types || {};
    const ct = contentTypesConfig[uid];
    if (!ct?.edit) return;

    const edit = ct.edit;
    const layouts = edit.layouts || edit.layout;
    if (!layouts || !Array.isArray(layouts)) return;

    let titleCell = null;
    let foundRowIdx = -1;
    let foundCellIdx = -1;

    for (let ri = 0; ri < layouts.length; ri++) {
      const row = layouts[ri];
      if (!Array.isArray(row)) continue;
      const ci = row.findIndex((c) => (c?.name ?? c?.field) === 'title');
      if (ci !== -1) {
        titleCell = row[ci];
        foundRowIdx = ri;
        foundCellIdx = ci;
        break;
      }
    }
    if (!titleCell) return;

    // Remove title from current position
    layouts[foundRowIdx].splice(foundCellIdx, 1);
    if (layouts[foundRowIdx].length === 0) layouts.splice(foundRowIdx, 1);

    // Insert title as first cell of first row
    if (layouts.length === 0) {
      layouts.push([titleCell]);
    } else {
      layouts[0].unshift(titleCell);
    }

    await store.set({ key: 'configuration', value: config });
    strapi.log.info('Content Manager: title moved to top of Flash News Item edit layout');
  } catch (err) {
    strapi.log.warn('Could not reorder Flash News Item layout:', err.message);
  }
}

/**
 * Ensure every content type has a Content Manager configuration in the store.
 * After a data transfer, some content types may have explorer.read permission but no
 * configuration in core-store, causing "Cannot read properties of undefined (reading 'settings')"
 * in the homepage service (getContentTypesMeta).
 */
async function ensureContentManagerConfigurations() {
  try {
    const contentTypesService = strapi.plugin('content-manager')?.service('content-types');
    if (contentTypesService && typeof contentTypesService.syncConfigurations === 'function') {
      await contentTypesService.syncConfigurations();
      strapi.log.info('Content Manager: synced configurations for all content types');
    }
  } catch (err) {
    strapi.log.warn('Could not sync content manager configurations:', err?.message ?? err);
  }
}

/**
 * Ensure Article list view shows publishedAt column and is sorted by publishedAt (newest first).
 * Writes to the same store/key the content-manager server uses so the configuration API
 * returns the list layout with publishedAt (key: configuration_content_types::api::article.article).
 */
async function ensureArticleListSortAndColumns() {
  const uid = 'api::article.article';
  const storeKey = `content_types::${uid}`;
  const configKey = `configuration_${storeKey}`;
  try {
    const store = strapi.store({ type: 'plugin', name: 'content_manager' });
    const config = (await store.get({ key: configKey })) || {};

    let updated = false;

    // List layout: array of attribute names (strings). Add publishedAt if missing.
    const listLayout = config.layouts?.list ?? [];
    const listCols = Array.isArray(listLayout) ? listLayout : [];
    if (!listCols.includes('publishedAt')) {
      config.layouts = config.layouts || { list: [], edit: [] };
      config.layouts.list = [...listCols, 'publishedAt'];
      updated = true;
    }

    // Settings: defaultSortBy and defaultSortOrder
    config.settings = config.settings || {};
    if (config.settings.defaultSortBy !== 'publishedAt' || config.settings.defaultSortOrder !== 'DESC') {
      config.settings.defaultSortBy = 'publishedAt';
      config.settings.defaultSortOrder = 'DESC';
      updated = true;
    }

    // Ensure publishedAt has metadata so list view can render the column
    config.metadatas = config.metadatas || {};
    config.metadatas.publishedAt = config.metadatas.publishedAt || {};
    config.metadatas.publishedAt.list = config.metadatas.publishedAt.list || {};
    if (config.metadatas.publishedAt.list.label !== 'publishedAt') {
      config.metadatas.publishedAt.list = {
        label: 'publishedAt',
        searchable: false,
        sortable: true,
        ...config.metadatas.publishedAt.list,
      };
      config.metadatas.publishedAt.edit = config.metadatas.publishedAt.edit || {};
      config.metadatas.publishedAt.edit.visible = true;
      updated = true;
    }

    if (updated) {
      await store.set({ key: configKey, value: config });
      strapi.log.info(
        'Content Manager: Article list sort=publishedAt:desc, publishedAt column and edit visible'
      );
    }
  } catch (err) {
    strapi.log.warn(
      'Could not set Article list sort/columns:',
      err.message
    );
  }
}

/**
 * Note: publishedAt for Article list view is injected in the content-manager
 * extension (strapi-server.js) by patching findContentTypeConfiguration.
 */

/**
 * Ensure all collection types have valid defaultSortBy and defaultSortOrder in their
 * Content Manager configuration. Prevents sort=undefined:undefined in list API (400 errors).
 */
async function ensureCollectionTypesHaveDefaultSort() {
  try {
    const store = strapi.store({ type: 'plugin', name: 'content_manager' });
    const contentTypes = Object.values(strapi.contentTypes).filter(
      (ct) => ct.kind === 'collectionType' && ct.uid?.startsWith('api::')
    );
    for (const ct of contentTypes) {
      const configKey = `configuration_content_types::${ct.uid}`;
      const config = (await store.get({ key: configKey })) || {};
      config.settings = config.settings || {};
      const mainField = config.settings.mainField || 'documentId';
      const defaultSortBy = config.settings.defaultSortBy ?? mainField;
      const defaultSortOrder = config.settings.defaultSortOrder ?? 'ASC';
      if (
        config.settings.defaultSortBy !== defaultSortBy ||
        config.settings.defaultSortOrder !== defaultSortOrder
      ) {
        config.settings.defaultSortBy = defaultSortBy;
        config.settings.defaultSortOrder = defaultSortOrder;
        await store.set({ key: configKey, value: config });
        strapi.log.info(
          `Content Manager: ${ct.uid} default sort=${defaultSortBy}:${defaultSortOrder}`
        );
      }
    }
  } catch (err) {
    strapi.log.warn('Could not ensure collection types default sort:', err?.message ?? err);
  }
}

/**
 * When re-publishing, refresh published_at to NOW so the item stays in "Last Published Entries".
 * Runs in the background so the publish response returns immediately (fixes spinning button).
 * Set DISABLE_PUBLISH_DATE_REFRESH=1 in .env to turn off if it causes frontend 404s.
 */
function registerPublishDateRefreshMiddleware() {
  if (process.env.DISABLE_PUBLISH_DATE_REFRESH === '1' || process.env.DISABLE_PUBLISH_DATE_REFRESH === 'true') {
    return;
  }
  strapi.documents.use(async (context, next) => {
    const doc = await next();
    if (context.action !== 'publish' || !doc?.documentId) return doc;
    const uid = context.uid;
    const documentId = doc.documentId;
    setImmediate(() => {
      (async () => {
        try {
          const ct = strapi.contentType(uid);
          if (ct?.options?.draftAndPublish && ct?.collectionName) {
            const now = new Date().toISOString();
            const db = strapi.db.connection;
            await db(ct.collectionName)
              .where({ document_id: documentId })
              .whereNotNull('published_at')
              .update({ published_at: now });
          }
        } catch (e) {
          strapi.log.warn('Could not refresh published_at on publish:', e.message);
        }
      })();
    });
    return doc;
  });
}

module.exports = async () => {
  await seedExampleApp();
  await ensureContentApiPublicPermissions();
  await registerTenantRBACConditions();
  await ensureEditorTenantScopedPermissions();
  await hideTenantFieldInContentManagerLayout();
  await ensureFlashNewsItemTitleFirst();
  await ensureContentManagerConfigurations();
  await ensureArticleListSortAndColumns();
  await ensureCollectionTypesHaveDefaultSort();
  registerPublishDateRefreshMiddleware();
  await registerTenantDocumentMiddleware();
};
