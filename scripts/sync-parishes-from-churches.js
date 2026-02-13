'use strict';

/**
 * Delete all parishes, then create one parish per church with the same data
 * (name, slug, diocese, address, contact fields, image, tenant). Parish does
 * not have location or website; vicar is left unset.
 *
 * Run from project root: node scripts/sync-parishes-from-churches.js
 * Optional: DRY_RUN=1 to skip delete and create (only list what would be done).
 */

try {
  require('dotenv').config();
} catch (_) {}

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

function slugify(str) {
  if (str == null || typeof str !== 'string') return '';
  return str
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
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
  } catch (_) {
    return false;
  }
}

async function getDocumentIds(strapi, uid) {
  const rows = await strapi.db.query(uid).findMany({
    select: ['id', 'documentId', 'document_id'],
  });
  return (rows || []).map((r) => r.documentId ?? r.document_id ?? r.id).filter(Boolean);
}

async function deleteAllParishes(strapi) {
  const uid = 'api::parish.parish';
  const docIds = await getDocumentIds(strapi, uid);
  if (docIds.length === 0) {
    console.log('Parishes: 0 (nothing to delete)');
    return;
  }
  if (DRY_RUN) {
    console.log('Parishes:', docIds.length, '(DRY_RUN – would delete, skipping)');
    return;
  }
  let deleted = 0;
  for (const documentId of docIds) {
    try {
      await strapi.documents(uid).delete({ documentId });
      deleted++;
    } catch (e) {
      console.warn('  Delete failed:', documentId, e.message);
    }
  }
  console.log('Parishes: deleted', deleted);
}

async function syncParishesFromChurches(strapi) {
  const churchUid = 'api::church.church';
  const parishUid = 'api::parish.parish';

  const churches = await strapi.documents(churchUid).findMany({
    populate: { diocese: true, image: true, tenant: true },
    limit: 10000,
  });
  const list = churches?.results ?? churches?.data ?? (Array.isArray(churches) ? churches : []);
  if (list.length === 0) {
    console.log('No churches found. Nothing to copy.');
    return;
  }
  console.log('Churches:', list.length, '– creating one parish per church with same data.');

  let created = 0;
  let imageLinked = 0;
  for (const c of list) {
    const dioceseDocId = c.diocese?.documentId ?? c.diocese?.id ?? c.diocese;
    if (!dioceseDocId) {
      console.warn('  Skip church (no diocese):', c.name);
      continue;
    }
    const dioceseSlug = c.diocese?.slug ?? slugify(c.diocese?.name ?? '');
    const parishSlug = dioceseSlug ? `${c.slug || slugify(c.name)}-${dioceseSlug}` : (c.slug || slugify(c.name));
    const tenantDocId = c.tenant?.documentId ?? c.tenant?.id ?? c.tenant;
    const tenantConnect = tenantDocId ? { connect: [tenantDocId] } : null;
    const imageConnect =
      c.image?.documentId ?? c.image?.id
        ? { connect: [{ documentId: c.image?.documentId ?? c.image?.id }] }
        : null;

    const data = {
      name: c.name,
      slug: parishSlug,
      diocese: { connect: [dioceseDocId] },
      address: c.address ?? undefined,
      email: c.email ?? undefined,
      phones: c.phones ?? undefined,
      phoneSecondary: c.phoneSecondary ?? undefined,
      addressLine1: c.addressLine1 ?? undefined,
      addressLine2: c.addressLine2 ?? undefined,
      city: c.city ?? undefined,
      state: c.state ?? undefined,
      postalCode: c.postalCode ?? undefined,
      country: c.country ?? undefined,
      ...(tenantConnect ? { tenant: tenantConnect } : {}),
      ...(imageConnect ? { image: imageConnect } : {}),
    };

    if (DRY_RUN) {
      console.log('  Would create parish:', c.name, '| slug:', parishSlug);
      created++;
      continue;
    }

    try {
      let createdDoc = await strapi.documents(parishUid).create({ data });
      if (!createdDoc) continue;
      const parishDocId = createdDoc?.documentId ?? createdDoc?.id;
      if (tenantConnect && parishDocId) {
        const hasTenant = createdDoc?.tenant?.documentId ?? createdDoc?.tenant?.id ?? createdDoc?.tenant;
        if (!hasTenant) {
          try {
            const tid = tenantConnect.connect?.[0];
            await strapi.documents(parishUid).update({
              documentId: parishDocId,
              data: { tenant: { connect: [tid] } },
            });
          } catch (_) {}
        }
      }
      if (imageConnect && parishDocId) {
        const fileDocId = imageConnect?.connect?.[0]?.documentId ?? imageConnect?.connect?.[0];
        if (fileDocId && (await setMediaRelationViaDb(strapi, parishUid, parishDocId, fileDocId, 'image'))) {
          imageLinked++;
        }
      }
      created++;
    } catch (e) {
      if (imageConnect && e.message && /relation|invalid/i.test(e.message)) {
        try {
          delete data.image;
          const createdDoc = await strapi.documents(parishUid).create({ data });
          const parishDocId = createdDoc?.documentId ?? createdDoc?.id;
          if (tenantConnect && parishDocId && !(createdDoc?.tenant?.documentId ?? createdDoc?.tenant?.id ?? createdDoc?.tenant)) {
            try {
              await strapi.documents(parishUid).update({
                documentId: parishDocId,
                data: { tenant: { connect: [tenantConnect.connect[0]] } },
              });
            } catch (_) {}
          }
          const fileDocId = imageConnect?.connect?.[0]?.documentId ?? imageConnect?.connect?.[0];
          if (parishDocId && fileDocId && (await setMediaRelationViaDb(strapi, parishUid, parishDocId, fileDocId, 'image'))) {
            imageLinked++;
          }
          created++;
        } catch (e2) {
          console.warn('  Skip parish', c.name, e2.message);
        }
      } else {
        console.warn('  Skip parish', c.name, e.message);
      }
    }
  }
  console.log(DRY_RUN ? `Would create ${created} parishes.` : `Created ${created} parishes, image linked: ${imageLinked}.`);
}

async function main() {
  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  try {
    if (DRY_RUN) console.log('DRY RUN – no data will be changed.\n');
    await deleteAllParishes(app);
    await syncParishesFromChurches(app);
    console.log('\nDone.');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await app.destroy();
  }
  process.exit(process.exitCode || 0);
}

main();
