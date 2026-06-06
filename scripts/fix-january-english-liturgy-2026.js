'use strict';

/**
 * Fix January 2026 English headings for Liturgy Day entries for one tenant.
 * This script only writes date/dayHeadingEn/tenant (and order when creating missing rows).
 *
 * Run:
 *   node scripts/fix-january-english-liturgy-2026.js --tenant-id=tenant_demo_002
 *   DRY_RUN=1 node scripts/fix-january-english-liturgy-2026.js --tenant-id=tenant_demo_002
 */

const { DRY_RUN, getTenantId } = require('./lib/liturgy-cli');

const LITURGY_DAY_UID = 'api::liturgy-day.liturgy-day';

const JANUARY_ENGLISH_BY_DATE = new Map([
  ['2026-01-01', `New Year.
Circumcision of our Lord.
Feast of St. Basil and St. Gregory & All
the Holy Fathers.`],
  ['2026-01-03', `62th Commemoration of H. H. Baselios
Geevarghese II Catholicos.
(Catholicate Aramana, Devalokam).
Memorial Day of Oath of Koonan Cross.
(St. George Church, Mattanchery).`],
  ['2026-01-04', `Second Sunday after Christmas.
(Niram 2)`],
  ['2026-01-06', `Epiphany/Danaha (Baptism of our
Lord Jesus Christ). (Niram 2)`],
  ['2026-01-07', `Feast Commemorating the Beheading
of St. John the Baptist. (Niram 8)`],
  ['2026-01-08', `Feast Commemorating the Martyrdom
of St. Stephen. (Niram 8)`],
  ['2026-01-11', `First Sunday after Epiphany.
(Niram 3)`],
  ['2026-01-15', `Feast of St. Mary for Seeds. (Niram 1)
Commemoration of Paul the Monk.`],
  ['2026-01-18', `Second Sunday after Epiphany.
(Niram 4)
Feast of St. Samuel, St. Simon & St.
Antony.`],
  ['2026-01-21', `17th Commemoration of H.G. Philipose
Mar Eusebius Metropolitan. (St. Basil
Dayara, Pathanamthitta).`],
  ['2026-01-22', `210th Commemoration of Marthoma
VIII. (Puthencavu Cathedral).`],
  ['2026-01-23', `Commemoration of St. Augen the
Monk.`],
  ['2026-01-25', `Sunday before Nineveh Lent
(Pethurtho of Nineveh Lent).
(Niram 6)
Commemoration of All Departed
Fathers and Malpans.`],
  ['2026-01-26', `Monday of Nineveh Lent.
20th Commemoration of H. H. Baselios
Marthoma Mathews II Catholicos.
(Mount Horeb Ashram, Sastham
cotta).
72th Commemoration of H. G. Paulose
Mar Athanasios Metropolitan,
Kuttikkattil.
(Thrikkunnathu Seminary, Aluva).
Republic Day.`],
  ['2026-01-29', `The end of Nineveh Lent. (Niram 6)
Commemoration of Prophet Jonah.
Feast of Mar Severios of Antioch`],
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
  for (const [date, dayHeadingEn] of JANUARY_ENGLISH_BY_DATE.entries()) {
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
