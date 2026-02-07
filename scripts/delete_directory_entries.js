'use strict';

/**
 * Delete all Directory entries: Bishops, Churches, Dioceses, Directory Entries, Parishes, Priests.
 * Use for a clean slate before re-running the directory import (e.g. to fix tenant mapping).
 *
 * Run from project root: node scripts/delete_directory_entries.js
 * Optional: DRY_RUN=1 to only list counts and skip deletion.
 */

try {
  require('dotenv').config();
} catch (_) {}

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const DIRECTORY_TYPES = [
  { uid: 'api::priest.priest', label: 'Directory – Priests' },
  { uid: 'api::church.church', label: 'Directory – Churches' },
  { uid: 'api::parish.parish', label: 'Directory – Parishes' },
  { uid: 'api::bishop.bishop', label: 'Directory – Bishops' },
  { uid: 'api::catholicos.catholicos', label: 'Directory – The Catholicos' },
  { uid: 'api::diocesan-bishop.diocesan-bishop', label: 'Directory – Diocesan Bishops' },
  { uid: 'api::retired-bishop.retired-bishop', label: 'Directory – Retired Bishops' },
  { uid: 'api::directory-entry.directory-entry', label: 'Directory – Entries' },
  { uid: 'api::institution.institution', label: 'Directory – Institutions' },
  { uid: 'api::church-dignitary.church-dignitary', label: 'Directory – Church Dignitaries' },
  { uid: 'api::working-committee.working-committee', label: 'Directory – Working Committee' },
  { uid: 'api::managing-committee.managing-committee', label: 'Directory – The Managing Committee' },
  { uid: 'api::spiritual-organisation.spiritual-organisation', label: 'Directory – Spiritual Organisations' },
  { uid: 'api::pilgrim-centre.pilgrim-centre', label: 'Directory – Pilgrim Centres' },
  { uid: 'api::seminary.seminary', label: 'Directory – Seminaries' },
  { uid: 'api::diocese.diocese', label: 'Directory – Dioceses' },
];

async function getDocumentIds(strapi, uid) {
  const rows = await strapi.db.query(uid).findMany({
    select: ['id', 'documentId', 'document_id'],
  });
  return (rows || []).map((r) => r.documentId ?? r.document_id ?? r.id).filter(Boolean);
}

async function deleteAllDirectoryEntries(strapi) {
  for (const { uid, label } of DIRECTORY_TYPES) {
    const docIds = await getDocumentIds(strapi, uid);
    const count = docIds.length;
    if (count === 0) {
      console.log(label + ': 0 entries (skip)');
      continue;
    }
    if (DRY_RUN) {
      console.log(label + ':', count, 'entries (DRY_RUN – not deleted)');
      continue;
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
    console.log(label + ':', deleted, 'deleted');
  }
}

async function main() {
  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  try {
    if (DRY_RUN) console.log('DRY RUN – no data will be deleted.\n');
    await deleteAllDirectoryEntries(app);
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
