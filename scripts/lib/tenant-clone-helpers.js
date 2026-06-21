'use strict';

const {
  CLONE_ORDER,
  SINGLE_TYPE_UIDS,
  GLOBAL_RELATION_TARGETS,
  SYSTEM_FIELDS,
  MEDIA_FIELD_TYPES,
  pluralFromUid,
} = require('./tenant-clone-config');

function parseCloneArgs(argv = process.argv) {
  const getArg = (name, defaultValue = null) => {
    for (let i = 2; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === `--${name}` && argv[i + 1]) return argv[i + 1].trim();
      const m = arg.match(new RegExp(`^--${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=(.+)$`));
      if (m) return m[1].trim();
    }
    return defaultValue;
  };

  const typesRaw = getArg('types', '');
  const types = typesRaw
    ? typesRaw.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
    : null;

  return {
    sourceTenantId: getArg('source-tenant-id', process.env.SOURCE_TENANT_ID || 'tenant_demo_002'),
    targetTenantId: getArg('target-tenant-id', process.env.TARGET_TENANT_ID),
    slugSuffix: getArg('slug-suffix', ''),
    createTarget: argv.includes('--create-target'),
    dryRun: argv.includes('--dry-run') || process.env.DRY_RUN === '1',
    skipExisting: !argv.includes('--force'),
    cleanTarget: argv.includes('--clean-target'),
    targetName: getArg('target-name', null),
    targetDomain: getArg('target-domain', null),
    types,
    batchSize: Math.max(1, parseInt(getArg('batch-size', '50'), 10) || 50),
  };
}

async function resolveTenant(strapi, tenantId) {
  if (!tenantId) return null;
  return strapi.db.query('api::tenant.tenant').findOne({
    where: { tenantId },
  });
}

function tenantDocumentFilter(tenant) {
  if (!tenant) return null;
  const docId = tenant.documentId ?? tenant.document_id;
  if (docId != null) {
    return { $or: [{ tenant: tenant.id }, { tenant: { documentId: docId } }] };
  }
  return { tenant: tenant.id };
}

async function findDocumentsForTenant(strapi, uid, tenant, options = {}) {
  const { status = undefined, limit = 10000 } = options;
  const filters = tenantDocumentFilter(tenant);
  if (!filters) return [];

  const ct = strapi.contentTypes[uid];
  const params = { filters, limit, populate: '*' };
  if (status && ct?.options?.draftAndPublish) {
    params.status = status;
  }

  const result = await strapi.documents(uid).findMany(params);
  return result?.results ?? result?.data ?? (Array.isArray(result) ? result : []);
}

async function countDocumentsForTenant(strapi, uid, tenant) {
  const ct = strapi.contentTypes[uid];
  if (!ct || SINGLE_TYPE_UIDS.has(uid)) {
    if (SINGLE_TYPE_UIDS.has(uid)) return { count: 1, note: 'singleType (max 1 per instance)' };
    return { count: 0, note: 'unknown type' };
  }

  const filters = tenantDocumentFilter(tenant);
  if (!filters) return { count: 0 };

  if (ct.options?.draftAndPublish) {
    const draft = await strapi.documents(uid).count({ filters, status: 'draft' });
    const published = await strapi.documents(uid).count({ filters, status: 'published' });
    return { count: draft, draft, published };
  }

  const count = await strapi.documents(uid).count({ filters });
  return { count };
}

function resolveUidFromTypeToken(strapi, token) {
  const lower = token.toLowerCase();
  for (const uid of CLONE_ORDER) {
    const plural = pluralFromUid(uid);
    const singular = uid.split('.')[1];
    if (lower === plural || lower === singular || lower === uid) return uid;
  }
  const direct = `api::${lower}.${lower}`;
  if (strapi.contentTypes[direct]) return direct;
  return null;
}

function filterCloneOrder(strapi, typesFilter) {
  if (!typesFilter?.length) return CLONE_ORDER.filter((uid) => strapi.contentTypes[uid]);
  const uids = typesFilter
    .map((t) => resolveUidFromTypeToken(strapi, t))
    .filter(Boolean);
  return CLONE_ORDER.filter((uid) => uids.includes(uid));
}

function getSchemaAttributes(strapi, uid) {
  const ct = strapi.contentTypes[uid];
  if (!ct?.attributes) return {};
  return ct.attributes instanceof Map ? Object.fromEntries(ct.attributes) : ct.attributes;
}

function getRelationMeta(strapi, uid, fieldName) {
  const attrs = getSchemaAttributes(strapi, uid);
  const attr = attrs[fieldName];
  if (!attr || attr.type !== 'relation') return null;
  return { target: attr.target, relation: attr.relation };
}

function extractRelationDocumentId(value) {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    return String(value.documentId ?? value.document_id ?? value.id ?? '');
  }
  return null;
}

function extractMediaDocumentId(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    const first = value[0];
    return extractRelationDocumentId(first);
  }
  return extractRelationDocumentId(value);
}

function applySlugSuffix(slug, suffix) {
  if (!slug || !suffix) return slug;
  const base = String(slug);
  if (base.endsWith(suffix)) return base;
  return `${base}${suffix}`;
}

function toKebabSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildClonePayload(strapi, uid, sourceDoc, ctx) {
  const { idMap, targetTenant, args } = ctx;
  const slugSuffix = args?.slugSuffix || '';
  const attrs = getSchemaAttributes(strapi, uid);
  const data = {};

  for (const [field, attr] of Object.entries(attrs)) {
    if (SYSTEM_FIELDS.has(field)) continue;
    if (field === 'tenant') continue;

    const value = sourceDoc[field];

    if (attr.type === 'uid') {
      let base = value ?? sourceDoc[field];
      if (!base && attr.targetField && sourceDoc[attr.targetField]) {
        base = toKebabSlug(sourceDoc[attr.targetField]);
      }
      if (base) {
        data[field] = slugSuffix ? applySlugSuffix(String(base), slugSuffix) : String(base);
      }
      continue;
    }

    if (value === undefined) continue;

    if (attr.type === 'relation') {
      if (attr.relation === 'oneToMany' || attr.relation === 'manyToMany') {
        continue;
      }
      const target = attr.target;
      if (GLOBAL_RELATION_TARGETS.has(target)) {
        if (ctx.resolveGlobalRelation) {
          const resolved = ctx.resolveGlobalRelation(target, value);
          if (resolved) data[field] = resolved;
        } else {
          const relId = extractRelationDocumentId(value);
          if (relId) data[field] = relId;
        }
        continue;
      }
      const oldRelDocId = extractRelationDocumentId(value);
      if (!oldRelDocId) continue;
      const mapped = idMap.get(`${target}:${oldRelDocId}`);
      if (mapped) {
        data[field] = mapped;
      }
      continue;
    }

    if (MEDIA_FIELD_TYPES.has(attr.type)) {
      continue;
    }

    if (attr.type === 'component' || attr.type === 'dynamiczone') {
      data[field] = value;
      continue;
    }

    data[field] = value;
  }

  const targetRel = targetTenant.documentId ?? targetTenant.id;
  data.tenant = targetRel;

  return data;
}

async function setMediaRelationViaDb(strapi, contentTypeUid, entityDocumentId, fileDocumentId, fieldName = 'image') {
  if (!entityDocumentId || !fileDocumentId) return false;
  const entityRow = await strapi.db.query(contentTypeUid).findOne({
    where: { documentId: entityDocumentId },
    select: ['id'],
  });
  const fileRow = await strapi.db.query('plugin::upload.file').findOne({
    where: { documentId: fileDocumentId },
    select: ['id'],
  });
  if (!entityRow?.id || !fileRow?.id) return false;
  const db = strapi.db.connection;
  const morphTable = 'files_related_mph';
  try {
    await db(morphTable).where({ related_id: entityRow.id, related_type: contentTypeUid, field: fieldName }).del();
    await db(morphTable).insert({
      file_id: fileRow.id,
      related_id: entityRow.id,
      related_type: contentTypeUid,
      field: fieldName,
      order: 1,
    });
    return true;
  } catch {
    return false;
  }
}

async function linkMediaFieldsFromSource(strapi, uid, sourceDoc, newDocumentId) {
  const attrs = getSchemaAttributes(strapi, uid);
  for (const [field, attr] of Object.entries(attrs)) {
    if (!MEDIA_FIELD_TYPES.has(attr.type)) continue;
    const fileDocId = extractMediaDocumentId(sourceDoc[field]);
    if (fileDocId) {
      await setMediaRelationViaDb(strapi, uid, newDocumentId, fileDocId, field);
    }
  }
}

async function ensureTargetTenant(strapi, args, sourceTenant) {
  let target = await resolveTenant(strapi, args.targetTenantId);
  if (target) return target;

  if (!args.createTarget) {
    throw new Error(
      `Target tenant "${args.targetTenantId}" not found. Pass --create-target to create it.`
    );
  }

  if (args.dryRun) {
    console.log(`[dry-run] Would create tenant: ${args.targetTenantId}`);
    return {
      id: -1,
      documentId: `dry-run-${args.targetTenantId}`,
      tenantId: args.targetTenantId,
      name: args.targetName || `${sourceTenant?.name || 'Tenant'} (clone)`,
      domain: args.targetDomain || sourceTenant?.domain || 'example.com',
    };
  }

  const payload = {
    name: args.targetName || `${sourceTenant.name} (clone)`,
    tenantId: args.targetTenantId,
    domain: args.targetDomain || sourceTenant.domain || args.targetTenantId,
    description: sourceTenant.description
      ? `Cloned from ${sourceTenant.tenantId}. ${sourceTenant.description}`.slice(0, 255)
      : `Cloned from ${sourceTenant.tenantId}`,
  };

  const created = await strapi.documents('api::tenant.tenant').create({ data: payload });
  console.log('Created target tenant:', args.targetTenantId);
  return strapi.db.query('api::tenant.tenant').findOne({ where: { tenantId: args.targetTenantId } });
}

function slugEndsWithSuffix(slug, suffix) {
  if (!slug || !suffix) return false;
  return String(slug).endsWith(suffix);
}

/** Delete collection rows for target tenant and orphan clone rows (slug suffix, no tenant link). */
async function cleanTargetTenantRecords(strapi, targetTenant, order, slugSuffix = '') {
  const reversed = [...order].reverse();
  let deleted = 0;

  for (const uid of reversed) {
    const ct = strapi.contentTypes[uid];
    if (!ct || ct.kind === 'singleType') continue;
    const attrs = getSchemaAttributes(strapi, uid);
    const hasSlug = Object.values(attrs).some((attr) => attr?.type === 'uid');

    const byTenant = await findDocumentsForTenant(strapi, uid, targetTenant, {});
    const toDelete = new Map();
    for (const doc of byTenant) {
      const documentId = doc.documentId ?? doc.document_id;
      if (documentId) toDelete.set(String(documentId), doc);
    }

    if (slugSuffix && hasSlug) {
      const allDocs = await strapi.documents(uid).findMany({ limit: 10000, populate: { tenant: true } });
      const allList = allDocs?.results ?? allDocs?.data ?? (Array.isArray(allDocs) ? allDocs : []);
      for (const doc of allList) {
        const documentId = String(doc.documentId ?? doc.document_id ?? '');
        if (!documentId || !slugEndsWithSuffix(doc.slug, slugSuffix)) continue;
        const tenantDocId = doc.tenant?.documentId ?? doc.tenant?.document_id;
        const tenantId = doc.tenant?.tenantId;
        const targetDocId = targetTenant.documentId ?? targetTenant.document_id;
        const isTarget =
          tenantDocId === targetDocId ||
          tenantId === targetTenant.tenantId ||
          doc.tenant?.id === targetTenant.id;
        if (!isTarget) {
          toDelete.set(documentId, doc);
        }
      }
    }

    if (!toDelete.size) continue;
    console.log(`  Cleaning ${toDelete.size} ${uid}...`);
    for (const documentId of toDelete.keys()) {
      try {
        await strapi.documents(uid).delete({ documentId });
        deleted++;
      } catch (err) {
        console.warn(`    Delete failed ${uid} ${documentId}:`, err.message);
      }
    }
  }
  console.log('Cleaned target tenant records:', deleted);
  return deleted;
}

async function cloneCollectionType(strapi, uid, ctx) {
  const { sourceTenant, targetTenant, args, idMap, stats } = ctx;
  const ct = strapi.contentTypes[uid];
  if (!ct || ct.kind === 'singleType') {
    stats.skipped.push({ uid, reason: 'singleType or missing schema' });
    return;
  }

  const isDraftPublish = Boolean(ct.options?.draftAndPublish);
  const status = isDraftPublish ? 'draft' : undefined;
  const docs = await findDocumentsForTenant(strapi, uid, sourceTenant, { status });

  if (docs.length === 0) {
    stats.empty.push(uid);
    return;
  }

  console.log(`\n[${uid}] cloning ${docs.length} document(s)...`);

  for (const sourceDoc of docs) {
    const oldDocumentId = String(sourceDoc.documentId ?? sourceDoc.document_id ?? '');
    if (!oldDocumentId) {
      stats.failed.push({ uid, reason: 'missing documentId' });
      continue;
    }

    const mapKey = `${uid}:${oldDocumentId}`;
    if (args.skipExisting && idMap.has(mapKey)) {
      stats.skipped.push({ uid, documentId: oldDocumentId, reason: 'already cloned in session' });
      continue;
    }

    const slugField = sourceDoc.slug;
    if (slugField && args.skipExisting && args.slugSuffix) {
      const suffixedSlug = applySlugSuffix(slugField, args.slugSuffix);
      const existing = await strapi.documents(uid).findMany({
        filters: {
          slug: suffixedSlug,
          ...tenantDocumentFilter(targetTenant),
        },
        limit: 1,
      });
      const existingList = existing?.results ?? existing?.data ?? [];
      if (existingList.length > 0) {
        const existingDocId = String(existingList[0].documentId ?? existingList[0].document_id);
        idMap.set(mapKey, existingDocId);
        stats.skipped.push({ uid, documentId: oldDocumentId, reason: 'slug exists on target' });
        continue;
      }
    }

    if (args.dryRun) {
      stats.created.push({ uid, documentId: oldDocumentId, dryRun: true });
      continue;
    }

    try {
      const data = buildClonePayload(strapi, uid, sourceDoc, ctx);
      const created = await strapi.documents(uid).create({ data });
      const newDocumentId = String(created.documentId ?? created.document_id ?? '');
      if (!newDocumentId) throw new Error('create returned no documentId');

      idMap.set(mapKey, newDocumentId);

      const targetRel = targetTenant.documentId ?? targetTenant.id;
      if (targetRel) {
        try {
          await strapi.documents(uid).update({
            documentId: newDocumentId,
            data: { tenant: targetRel },
          });
        } catch (tenantErr) {
          console.warn(`  Tenant link failed ${uid} ${newDocumentId}:`, tenantErr.message);
        }
      }

      await linkMediaFieldsFromSource(strapi, uid, sourceDoc, newDocumentId);

      if (isDraftPublish) {
        const publishedSource = await strapi.documents(uid).findOne({
          documentId: oldDocumentId,
          status: 'published',
        });
        if (publishedSource?.publishedAt) {
          await strapi.documents(uid).publish({ documentId: newDocumentId });
        }
      }

      stats.created.push({ uid, from: oldDocumentId, to: newDocumentId });
    } catch (err) {
      stats.failed.push({ uid, documentId: oldDocumentId, error: err.message });
      console.warn(`  Failed ${uid} ${oldDocumentId}:`, err.message);
    }
  }
}

function printStatsReport(stats, args) {
  console.log('\n========== Clone summary ==========');
  console.log('Source tenant:', args.sourceTenantId);
  console.log('Target tenant:', args.targetTenantId);
  console.log('Dry run:', args.dryRun);
  console.log('Created:', stats.created.length);
  console.log('Skipped:', stats.skipped.length);
  console.log('Failed:', stats.failed.length);
  if (stats.empty.length) {
    console.log('Empty types:', stats.empty.join(', '));
  }
  if (stats.failed.length) {
    console.log('\nFailures (first 10):');
    stats.failed.slice(0, 10).forEach((f) => {
      console.log(`  ${f.uid} ${f.documentId || ''}: ${f.error || f.reason}`);
    });
  }
}

module.exports = {
  parseCloneArgs,
  resolveTenant,
  tenantDocumentFilter,
  findDocumentsForTenant,
  countDocumentsForTenant,
  filterCloneOrder,
  ensureTargetTenant,
  cleanTargetTenantRecords,
  cloneCollectionType,
  printStatsReport,
  buildClonePayload,
  getSchemaAttributes,
  extractRelationDocumentId,
  extractMediaDocumentId,
  applySlugSuffix,
  pluralFromUid,
  SINGLE_TYPE_UIDS,
  CLONE_ORDER,
  GLOBAL_RELATION_TARGETS,
};
