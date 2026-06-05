'use strict';

/**
 * Fix July 2026 English headings for Liturgy Day entries for one tenant.
 * This script only writes date/dayHeadingEn/tenant (and order when creating missing rows).
 *
 * Run:
 *   node scripts/fix-july-english-liturgy-2026.js --tenant-id=tenant_demo_002
 *   DRY_RUN=1 node scripts/fix-july-english-liturgy-2026.js --tenant-id=tenant_demo_002
 */

const { DRY_RUN, getTenantId } = require('./lib/liturgy-cli');

const LITURGY_DAY_UID = 'api::liturgy-day.liturgy-day';

const JULY_ENGLISH_BY_DATE = new Map([
  ['2026-07-03', `Dukhrono of St. Thomas. (Niram 8)`],
  ['2026-07-05', `Sixth Sunday after Pentecost.
(Niram 5) Mission Sunday.
Feast of the Seventy-Two Evangelists.
217th Commemoration of Marthoma
VII. (Kolencherry Church).`],
  ['2026-07-07', `29th Commemoration of H. G.
Zachariah Mar Dionysius Metropolitan.
(Mount Tabor Dayara, Pathanapuram).`],
  ['2026-07-10', `253th Commemoration of H. G.
Yuhanon Mar Gregorios Metropolitan.
(Mulanthuruthy Cathedral).`],
  ['2026-07-11', `117th Commemoration of Malankara
Sabha Thejus H. G. Pulikkottil Joseph
Mar Dionysius V Metropolitan, Founder
of the Kottayam M. D. Seminary. (Old
Seminary, Kottayam).`],
  ['2026-07-12', `Seventh Sunday after Pentecost.
(Niram 6)
5th Commemoration of H. H. Baselios
Marthoma Paulose II Catholicos.
(Catholicate Aramana, Devalokam).`],
  ['2026-07-15', `Feast of the Kuriakose the Martyr and
his mother Marth Yulithy & St. Abahai
of Nicea.`],
  ['2026-07-19', `Eighth Sunday after Pentecost.
(Niram 7)`],
  ['2026-07-20', `Feast of Prophet Mar Elijah.`],
  ['2026-07-22', `Feast of St. Mary Magdalene.`],
  ['2026-07-23', `27th Commemoration of H. G.
Geevarghese Mar Dioscoros Metropolitan.
(Holy Trinity Ashram, Ranni).`],
  ['2026-07-25', `Feast of Mar Epiphanios of Cyprus.`],
  ['2026-07-26', `Nineth Sunday after Pentecost.
(Niram 8)`],
  ['2026-07-27', `Feast of St. Simon the Stylite.`],
  ['2026-07-31', `740th Feast of Mar Gregorios Bar
Hebraeus.`],
]);

function tenantFilters(tenant) {
  const docId = tenant.documentId ?? tenant.document_id;
  return docId != null
    ? { $or: [{ tenant: tenant.id }, { tenant: { documentId: docId } }] }
    : { tenant: tenant.id };
}

async function main() {
  const tenantId = getTenantId({ defaultValue: 'tenant_demo_002' });

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const app = await createStrapi(await compileStrapi()).load();
  app.log.level = 'error';

  const tenant = await app.db.query('api::tenant.tenant').findOne({
    where: { tenantId },
    select: ['id', 'documentId', 'document_id'],
  });
  if (!tenant) {
    console.error('Tenant not found:', tenantId);
    await app.destroy();
    process.exit(1);
  }

  const filters = tenantFilters(tenant);
  const result = await app.documents(LITURGY_DAY_UID).findMany({ filters, limit: 50000 });
  const list = result?.results ?? result?.data ?? (Array.isArray(result) ? result : []);

  const byDate = new Map();
  let maxOrder = 0;
  for (const doc of list) {
    const dateStr =
      typeof doc.date === 'string'
        ? doc.date.slice(0, 10)
        : doc.date?.toISOString?.()?.slice(0, 10);
    if (!dateStr) continue;
    if (!byDate.has(dateStr)) byDate.set(dateStr, []);
    byDate.get(dateStr).push(doc);
    if (typeof doc.order === 'number') maxOrder = Math.max(maxOrder, doc.order);
  }

  let updated = 0;
  let created = 0;
  let unchanged = 0;
  for (const [date, dayHeadingEn] of JULY_ENGLISH_BY_DATE.entries()) {
    const docs = byDate.get(date) || [];
    if (docs.length === 0) {
      const data = {
        date,
        dayHeadingEn,
        dayHeadingMalylm: null,
        seasonNameEn: null,
        seasonNameMalylm: null,
        readings: [],
        order: ++maxOrder,
        tenant: tenant.id,
      };
      if (DRY_RUN) {
        console.log('Would create missing date:', date);
        created++;
      } else {
        const createdDoc = await app.documents(LITURGY_DAY_UID).create({ data });
        if (createdDoc?.documentId) {
          try {
            await app.db.query(LITURGY_DAY_UID).update({
              where: { documentId: createdDoc.documentId },
              data: { tenant: tenant.id },
            });
          } catch (_) {}
        }
        console.log('Created missing date:', date);
        created++;
      }
      continue;
    }

    for (const doc of docs) {
      if ((doc.dayHeadingEn || '') === dayHeadingEn) {
        unchanged++;
        continue;
      }
      if (DRY_RUN) {
        console.log('Would update:', date, doc.documentId);
        updated++;
      } else {
        await app.documents(LITURGY_DAY_UID).update({
          documentId: doc.documentId,
          data: { dayHeadingEn },
        });
        console.log('Updated:', date, doc.documentId);
        updated++;
      }
    }
  }

  console.log('');
  console.log(DRY_RUN ? 'Would update' : 'Updated', updated, 'record(s)');
  console.log(DRY_RUN ? 'Would create' : 'Created', created, 'record(s)');
  console.log('Unchanged', unchanged, 'record(s)');

  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
