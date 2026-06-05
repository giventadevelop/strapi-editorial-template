'use strict';

/**
 * Fix February 2026 English headings for Liturgy Day entries for one tenant.
 * This script only writes date/dayHeadingEn/tenant (and order when creating missing rows).
 *
 * Run:
 *   node scripts/fix-february-english-liturgy-2026.js --tenant-id=tenant_demo_002
 *   DRY_RUN=1 node scripts/fix-february-english-liturgy-2026.js --tenant-id=tenant_demo_002
 */

const { DRY_RUN, getTenantId } = require('./lib/liturgy-cli');

const LITURGY_DAY_UID = 'api::liturgy-day.liturgy-day';

const FEBRUARY_ENGLISH_BY_DATE = new Map([
  ['2026-02-01', `Commemoration of all the
Departed Priests (Kohne Sunday).
(Niram 7)`],
  ['2026-02-02', `Mayaltho (Entry of our Lord into the
Temple). (Niram 3)
Commemoration of St. Simon and
Hanna. (Elder's Day).
58th Commemoration of H. G. Pathrose
Mar Osthathios Metropolitan,
Mookkancheril. (Carmel Dayara,
Kandanadu)`],
  ['2026-02-03', `Feast of St. Bar Soumo - the Chief
Among Mourners & Mar Kauma.`],
  ['2026-02-08', `Commemoration of all the
Departed Faithful (Anide Sunday).
(Niram 8)`],
  ['2026-02-09', `17th Commemoration of H. G. Mathews
Mar Epiphanios Metropolitan. (St.
Thomas Cathedral, Kollam).`],
  ['2026-02-13', `94th Commemoration of Patriarch
Ignatius Elias III. (Manjinikkara Dayara).`],
  ['2026-02-15', `First Sunday of Great Lent
(Kothine Sunday). (Pethurtha of
the Great Lent).
(Niram 1)`],
  ['2026-02-16', `First Monday of the Great Lent.
(Shubkono).
14th Commemoration of Sabha Ratnam
H. G. Dr. Geevarghese Mar Osthathios
Metropolitan. (St. Paul's Chapel,
Mavelikkara).`],
  ['2026-02-21', `Commemoration of Mar Ephrem
Malpan & Mar Theodoros the Martyr.
(First Saturday of the Great Lent).
(Niram 8)`],
  ['2026-02-22', `Second Sunday of Great Lent
(Garbo/Leper's Sunday). (Niram 2)`],
  ['2026-02-23', `92th Feast of Malankara Sabha Bhasuran
St. Geevarghese Mar Dionysius
Metropolitan Vattasseril. (Old Seminary, Kottayam).
18th Commemoration of H. G. Dr.
Thomas Mar Makarios Metropolitan.
(Catholicate Aramana, Devalokam).
Feast of St. Policarpos of Smyrna.`],
  ['2026-02-24', `Feast of St. Mathew the Evangelist.`],
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
  for (const [date, dayHeadingEn] of FEBRUARY_ENGLISH_BY_DATE.entries()) {
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
