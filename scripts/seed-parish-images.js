'use strict';

/**
 * Backfill parish image from the matching church (same name + diocese).
 * Use when Parish content type already has an image field but existing parishes
 * have no image (e.g. after adding the image field or before directory import
 * was updated to set parish images).
 *
 * Run from project root: node scripts/seed-parish-images.js
 * Optional: DRY_RUN=1 to only list what would be updated.
 */

try {
  require('dotenv').config();
} catch (_) {}

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

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

async function runBackfill(strapi) {
  const parishUid = 'api::parish.parish';
  const churchUid = 'api::church.church';

  const parishes = await strapi.documents(parishUid).findMany({
    populate: { image: true, diocese: true },
    limit: 5000,
  });
  const parishList = parishes?.results ?? parishes?.data ?? (Array.isArray(parishes) ? parishes : []);
  const withoutImage = parishList.filter((p) => !p.image?.documentId && !p.image?.id);
  if (withoutImage.length === 0) {
    console.log('No parishes without image. Nothing to do.');
    return;
  }

  const churches = await strapi.documents(churchUid).findMany({
    populate: { image: true, diocese: true },
    limit: 5000,
  });
  const churchList = churches?.results ?? churches?.data ?? (Array.isArray(churches) ? churches : []);
  const churchesWithImage = churchList.filter((c) => c.image?.documentId || c.image?.id);
  const churchByKey = new Map();
  for (const c of churchesWithImage) {
    const dioceseId = c.diocese?.documentId ?? c.diocese?.id ?? c.diocese;
    const key = `${(c.name || '').trim()}|${dioceseId || ''}`;
    if (!churchByKey.has(key)) churchByKey.set(key, c);
  }

  let updated = 0;
  for (const parish of withoutImage) {
    const dioceseId = parish.diocese?.documentId ?? parish.diocese?.id ?? parish.diocese;
    const key = `${(parish.name || '').trim()}|${dioceseId || ''}`;
    const church = churchByKey.get(key);
    if (!church) continue;
    const fileDocId = church.image?.documentId ?? church.image?.id;
    if (!fileDocId) continue;
    const parishDocId = parish.documentId ?? parish.id;
    if (DRY_RUN) {
      console.log('Would link image to parish:', parish.name, '| church:', church.name);
      updated++;
      continue;
    }
    const ok = await setMediaRelationViaDb(strapi, parishUid, parishDocId, fileDocId, 'image');
    if (ok) {
      console.log('Linked image to parish:', parish.name);
      updated++;
    }
  }
  console.log(DRY_RUN ? `Would update ${updated} parishes.` : `Updated ${updated} parishes.`);
}

async function main() {
  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  try {
    if (DRY_RUN) console.log('DRY RUN – no data will be changed.\n');
    await runBackfill(app);
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
