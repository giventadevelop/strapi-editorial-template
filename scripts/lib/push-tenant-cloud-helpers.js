'use strict';

const {
  buildClonePayload,
  getSchemaAttributes,
  findDocumentsForTenant,
  filterCloneOrder,
  pluralFromUid,
  SINGLE_TYPE_UIDS,
  GLOBAL_RELATION_TARGETS,
} = require('./tenant-clone-helpers');

function parsePushArgs(argv = process.argv) {
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
    tenantId: getArg('tenant-id', process.env.TARGET_TENANT_ID || process.env.TENANT_ID),
    dryRun: argv.includes('--dry-run') || process.env.DRY_RUN === '1',
    force: argv.includes('--force'),
    types,
    delayMs: Math.max(0, parseInt(getArg('delay-ms', process.env.REST_PUSH_DELAY_MS || '100'), 10) || 100),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function createCloudClient(cloudUrl, apiToken) {
  const base = cloudUrl.replace(/\/$/, '');

  async function cloudFetch(pathname, options = {}) {
    const url = pathname.startsWith('http') ? pathname : `${base}${pathname}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
        ...options.headers,
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}: ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : {};
  }

  return { cloudFetch, baseUrl: base };
}

async function fetchCloudTenants(cloudFetch) {
  const data = await cloudFetch('/api/tenants?pagination[pageSize]=500');
  const list = Array.isArray(data?.data) ? data.data : (data?.results ?? []);
  const map = new Map();
  for (const t of list) {
    const tenantId = t.tenantId ?? t.attributes?.tenantId ?? t.tenant_id;
    if (tenantId) {
      map.set(tenantId, {
        documentId: t.documentId ?? t.document_id ?? t.id,
        id: t.id,
        tenantId,
        ...t,
      });
    }
  }
  return map;
}

function cloudUpsertKeyFromRow(uid, row, tenantId) {
  if (uid === 'api::liturgy-day.liturgy-day') {
    const date = row.date ?? row.attributes?.date;
    return date ? `date:${date}_${tenantId || ''}` : null;
  }
  if (uid === 'api::advertisement-slot.advertisement-slot') {
    const position = row.position ?? row.attributes?.position ?? 'unknown';
    const priority = row.priority ?? row.attributes?.priority;
    const startDate = row.startDate ?? row.attributes?.startDate ?? '';
    const endDate = row.endDate ?? row.attributes?.endDate ?? '';
    const pri = priority != null ? priority : 'np';
    return `ad:${position}:${pri}:${startDate}:${endDate}_${tenantId || ''}`;
  }
  if (uid === 'api::flash-news-item.flash-news-item') {
    const title = row.title ?? row.attributes?.title;
    const content = row.content ?? row.attributes?.content;
    const t = String(title || content || '')
      .trim()
      .slice(0, 80);
    return t ? `flash:${t}_${tenantId || ''}` : null;
  }
  const slug = row.slug ?? row.attributes?.slug;
  if (uid === 'api::article.article' && slug) {
    return `slug:${slug}`;
  }
  return slug ? `${slug}_${tenantId || ''}` : null;
}

async function fetchCloudSlugMap(cloudFetch, plural, tenantId, uid = null) {
  const map = new Map();
  let page = 1;
  const pageSize = 100;
  while (true) {
    let url = `/api/${plural}?pagination[page]=${page}&pagination[pageSize]=${pageSize}&populate[tenant]=*`;
    if (tenantId) {
      url += `&filters[tenant][tenantId][$eq]=${encodeURIComponent(tenantId)}`;
    }
    const data = await cloudFetch(url);
    const list = Array.isArray(data?.data) ? data.data : (data?.results ?? []);
    if (!list.length) break;
    for (const row of list) {
      const docTenant =
        row.tenant?.tenantId ??
        row.tenant?.tenant_id ??
        row.tenant?.attributes?.tenantId;
      const documentId = row.documentId ?? row.document_id ?? row.id;
      const upsertKey = cloudUpsertKeyFromRow(uid, row, docTenant || tenantId || '');
      if (upsertKey && documentId) {
        map.set(upsertKey, documentId);
      }
    }
    if (list.length < pageSize) break;
    page++;
  }
  return map;
}

async function fetchGlobalSlugMaps(cloudFetch, strapi) {
  const maps = {
    'api::category.category': new Map(),
    'api::author.author': new Map(),
  };

  const configs = [
    { uid: 'api::category.category', plural: 'categories', key: 'slug' },
    { uid: 'api::author.author', plural: 'authors', key: 'name' },
  ];

  for (const { uid, plural, key } of configs) {
    let page = 1;
    while (true) {
      const data = await cloudFetch(
        `/api/${plural}?pagination[page]=${page}&pagination[pageSize]=100&fields[0]=${encodeURIComponent(key)}`
      );
      const list = Array.isArray(data?.data) ? data.data : (data?.results ?? []);
      if (!list.length) break;
      for (const row of list) {
        const mapKey = row[key] ?? row.attributes?.[key];
        const documentId = row.documentId ?? row.document_id ?? row.id;
        if (mapKey && documentId) maps[uid].set(String(mapKey), String(documentId));
      }
      if (list.length < 100) break;
      page++;
    }
  }

  return maps;
}

function resolveUpsertKey(uid, doc, tenantId) {
  if (uid === 'api::liturgy-day.liturgy-day') {
    const date = doc.date;
    return date ? `date:${date}_${tenantId}` : null;
  }
  const slug = doc.slug;
  return slug ? `${slug}_${tenantId}` : null;
}

function sanitizePayload(strapi, uid, data) {
  const attrs = getSchemaAttributes(strapi, uid);
  const out = { ...data };
  for (const [field, attr] of Object.entries(attrs)) {
    if (attr.required && out[field] == null) {
      if (attr.type === 'string' || attr.type === 'text') {
        if (uid === 'api::flash-news-item.flash-news-item' && field === 'title') {
          out.title = String(out.content || 'Flash news').slice(0, 255);
        } else {
          out[field] = '';
        }
      }
    }
  }
  return out;
}

function makeGlobalResolver(globalSlugMaps, cloudTenantDocId) {
  return (targetUid, value) => {
    if (targetUid === 'api::tenant.tenant') return cloudTenantDocId;
    if (!GLOBAL_RELATION_TARGETS.has(targetUid) || targetUid === 'plugin::upload.file') return null;
    if (targetUid === 'api::author.author') {
      const name = value?.name ?? value?.attributes?.name;
      if (name && globalSlugMaps[targetUid]?.has(String(name))) {
        return globalSlugMaps[targetUid].get(String(name));
      }
      return null;
    }
    const slug = value?.slug ?? value?.attributes?.slug;
    if (slug && globalSlugMaps[targetUid]?.has(String(slug))) {
      return globalSlugMaps[targetUid].get(String(slug));
    }
    return null;
  };
}

function docUpsertKeyFromPayload(uid, data, tenantId) {
  return cloudUpsertKeyFromRow(uid, data, tenantId);
}

async function pushCollectionType(strapi, uid, ctx) {
  const { tenant, cloudTenant, cloudFetch, args, idMap, globalSlugMaps, stats, delayMs } = ctx;
  const ct = strapi.contentTypes[uid];
  if (!ct || ct.kind === 'singleType' || SINGLE_TYPE_UIDS.has(uid)) {
    stats.skipped.push({ uid, reason: 'singleType or missing' });
    return;
  }

  const plural = pluralFromUid(uid, strapi);
  const isDraftPublish = Boolean(ct.options?.draftAndPublish);
  const status = isDraftPublish ? 'draft' : undefined;
  const docs = await findDocumentsForTenant(strapi, uid, tenant, { status, limit: 10000 });

  if (!docs.length) {
    stats.empty.push(uid);
    return;
  }

  const cloudTenantDocId = cloudTenant.documentId ?? cloudTenant.id;
  let cloudKeys = args.dryRun
    ? new Map()
    : await fetchCloudSlugMap(cloudFetch, plural, tenant.tenantId, uid);

  // If tenant links were wiped, tenant-filtered map is empty but slugs still exist.
  // Fall back to a global slug map so --force updates instead of duplicate-creates.
  if (!args.dryRun && cloudKeys.size === 0 && uid === 'api::article.article') {
    console.log('  Tenant-filtered Cloud map empty; falling back to global slug map...');
    cloudKeys = await fetchCloudSlugMap(cloudFetch, plural, null, uid);
  }

  console.log(`\n[${uid}] pushing ${docs.length} document(s)...`);

  // Advertisement slots have no slug; when force-updating news layout, replace
  // tenant ads to avoid duplicate position collisions (e.g. two sidebars).
  if (
    !args.dryRun &&
    args.force &&
    uid === 'api::advertisement-slot.advertisement-slot' &&
    cloudKeys.size > 0
  ) {
    console.log(`  Clearing ${cloudKeys.size} existing Cloud ad slot(s) for tenant before recreate...`);
    for (const cloudDocId of cloudKeys.values()) {
      try {
        await cloudFetch(`/api/${plural}/${cloudDocId}`, { method: 'DELETE' });
      } catch (e) {
        console.warn('  Delete ad failed:', cloudDocId, e.message);
      }
      if (delayMs) await sleep(delayMs);
    }
    cloudKeys.clear();
  }

  const pushCtx = {
    idMap,
    targetTenant: cloudTenant,
    args: { slugSuffix: '' },
    resolveGlobalRelation: makeGlobalResolver(globalSlugMaps, cloudTenantDocId),
  };

  for (const sourceDoc of docs) {
    const oldDocumentId = String(sourceDoc.documentId ?? sourceDoc.document_id ?? '');
    if (!oldDocumentId) {
      stats.failed.push({ uid, reason: 'missing documentId' });
      continue;
    }

    const mapKey = `${uid}:${oldDocumentId}`;
    let data = buildClonePayload(strapi, uid, sourceDoc, pushCtx);
    data = sanitizePayload(strapi, uid, data);
    data.tenant = cloudTenantDocId;

    const upsertKey = docUpsertKeyFromPayload(uid, data, tenant.tenantId);
    const existingCloudDocId = upsertKey ? cloudKeys.get(upsertKey) : null;

    if (existingCloudDocId && !args.force) {
      idMap.set(mapKey, String(existingCloudDocId));
      stats.skipped.push({ uid, documentId: oldDocumentId, reason: 'exists on cloud' });
      continue;
    }

    if (args.dryRun) {
      stats.created.push({ uid, documentId: oldDocumentId, dryRun: true, upsertKey });
      continue;
    }

    try {
      let cloudDocId = existingCloudDocId ? String(existingCloudDocId) : null;

      if (cloudDocId) {
        await cloudFetch(`/api/${plural}/${cloudDocId}`, {
          method: 'PUT',
          body: JSON.stringify({ data }),
        });
        stats.updated.push({ uid, from: oldDocumentId, to: cloudDocId });
      } else {
        const createRes = await cloudFetch(`/api/${plural}`, {
          method: 'POST',
          body: JSON.stringify({ data }),
        });
        cloudDocId = String(
          createRes?.data?.documentId ?? createRes?.data?.document_id ?? createRes?.documentId ?? ''
        );
        if (!cloudDocId) throw new Error('create returned no documentId');
        stats.created.push({ uid, from: oldDocumentId, to: cloudDocId });
        if (upsertKey) cloudKeys.set(upsertKey, cloudDocId);

        try {
          await cloudFetch(`/api/${plural}/${cloudDocId}`, {
            method: 'PUT',
            body: JSON.stringify({ data: { tenant: cloudTenantDocId } }),
          });
        } catch (_) {}
      }

      idMap.set(mapKey, cloudDocId);

      if (isDraftPublish) {
        const publishedSource = await strapi.documents(uid).findOne({
          documentId: oldDocumentId,
          status: 'published',
        });
        if (publishedSource?.publishedAt) {
          try {
            await cloudFetch(`/api/${plural}/${cloudDocId}/actions/publish`, {
              method: 'POST',
              body: JSON.stringify({}),
            });
          } catch {
            try {
              await cloudFetch(`/api/${plural}/${cloudDocId}`, {
                method: 'PUT',
                body: JSON.stringify({
                  data: { publishedAt: publishedSource.publishedAt },
                }),
              });
            } catch (pubErr) {
              console.warn(`  Publish failed ${uid} ${cloudDocId}:`, pubErr.message);
            }
          }
        }
      }
    } catch (err) {
      stats.failed.push({ uid, documentId: oldDocumentId, error: err.message });
      console.warn(`  Failed ${uid} ${oldDocumentId}:`, err.message);
    }

    if (delayMs) await sleep(delayMs);
  }
}

function printPushReport(stats, args, cloudUrl) {
  console.log('\n========== Push to Cloud summary ==========');
  console.log('Tenant:', args.tenantId);
  console.log('Cloud:', cloudUrl);
  console.log('Dry run:', args.dryRun);
  console.log('Created:', stats.created.length);
  console.log('Updated:', stats.updated.length);
  console.log('Skipped:', stats.skipped.length);
  console.log('Failed:', stats.failed.length);
  if (stats.empty.length) console.log('Empty types:', stats.empty.join(', '));
  if (stats.failed.length) {
    console.log('\nFailures (first 10):');
    stats.failed.slice(0, 10).forEach((f) => {
      console.log(`  ${f.uid} ${f.documentId || ''}: ${f.error || f.reason}`);
    });
  }
}

module.exports = {
  parsePushArgs,
  createCloudClient,
  fetchCloudTenants,
  fetchGlobalSlugMaps,
  filterCloneOrder,
  pushCollectionType,
  printPushReport,
  sleep,
};
