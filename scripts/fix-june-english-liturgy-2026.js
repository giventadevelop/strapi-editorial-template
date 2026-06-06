'use strict';

/**
 * Fix June 2026 English headings for Liturgy Day entries for one tenant.
 * This script only writes date/dayHeadingEn/tenant (and order when creating missing rows).
 *
 * Run:
 *   node scripts/fix-june-english-liturgy-2026.js --tenant-id=tenant_demo_002
 *   DRY_RUN=1 node scripts/fix-june-english-liturgy-2026.js --tenant-id=tenant_demo_002
 */

const { DRY_RUN, getTenantId } = require('./lib/liturgy-cli');

const LITURGY_DAY_UID = 'api::liturgy-day.liturgy-day';

const JUNE_ENGLISH_BY_DATE = new Map([
  ['2026-06-05', `World Environment Day.`],
  ['2026-06-06', `101th Commemoration of Karottuveettil
H. G. Yuyakim Mar Ivanios Metropolitan.
(Parumala Seminary).
19th Commemoration of H. G. Augen
Mar Dionysius Metropolitan.
(Vallikkattu Dayara, Vakathanam).`],
  ['2026-06-07', `Second Sunday after Pentecost.
(Niram 1)`],
  ['2026-06-11', `Feast of St. Bartholomew the
Apostle.
137th Commemoration of H. G. Simon
Mar Athanasios Metropolitan.
(Kottayam Puthen Pally).`],
  ['2026-06-14', `Third Sunday after Pentecost.
(Niram 2)`],
  ['2026-06-15', `Feast of St. Mary, Commemoration
of the Establishment of the First
Church in St. Mary's Name. (Niram 1)`],
  ['2026-06-16', `Beginning of Apostles' Fast (13 days
Sleeha Fast).`],
  ['2026-06-19', `Feast of St. James, Brother of Jesus
and the First Bishop of Jerusalem.`],
  ['2026-06-21', `Fourth Sunday after Pentecost.
(Niram 3)`],
  ['2026-06-24', `Commemoration of the Birth of St.
John the Baptist.`],
  ['2026-06-28', `Fifth Sunday after Pentecost.
(Niram 4)`],
  ['2026-06-29', `Feast of St. Peter and St. Paul. End
of Apostles' Fast (13 days Sleeha
Fast).`],
  ['2026-06-30', `Feast of the Twelve Apostles.`],
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
  for (const [date, dayHeadingEn] of JUNE_ENGLISH_BY_DATE.entries()) {
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
