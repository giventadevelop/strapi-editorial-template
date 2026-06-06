'use strict';

/**
 * Fix November 2026 English headings for Liturgy Day entries for one tenant.
 * This script only writes date/dayHeadingEn/tenant (and order when creating missing rows).
 *
 * Run:
 *   node scripts/fix-november-english-liturgy-2026.js --tenant-id=tenant_demo_002
 *   DRY_RUN=1 node scripts/fix-november-english-liturgy-2026.js --tenant-id=tenant_demo_002
 */

const { DRY_RUN, getTenantId } = require('./lib/liturgy-cli');

const LITURGY_DAY_UID = 'api::liturgy-day.liturgy-day';

const NOVEMBER_ENGLISH_BY_DATE = new Map([
  ['2026-11-01', `Koodosh Eetho Sunday
(Sanctification). (Niram 1)
Feast of All Saints.`],
  ['2026-11-02', `124rd Commemoration of St.
Geevarghese Mar Gregorios of
Parumala. (Parumala
Seminary).
119th Commemoration of H. G.
Kadavil Paulose Mar Athanasios
Metropolitan.
(Thrikkunnathu Seminary, Aluva).`],
  ['2026-11-05', `19th Commemoration of H. G.
Stephanos Mar Theodosius Metropolitan.
(St. Thomas Ashram, Bhilai).`],
  ['2026-11-06', `60th Commemoration of H. G.
Vayaliparambil Geevarghese Mar
Gregorios Metropolitan. (Thrikku
nnathu Seminary, Aluva).`],
  ['2026-11-08', `Hoodosh Eetho Sunday
(Dedication). (Niram 2)
30th Commemoration of H. H.  Baselios
Marthoma Mathews I Catholicos.
(Catholicate Aramana, Devalokam).`],
  ['2026-11-12', `214th Commemoration of Veda
Ratnam Kayamkulam Philipose
Ramban.
(Kannamkode Cathedral, Adoor).`],
  ['2026-11-13', `Feast of St. John Chrysostom.`],
  ['2026-11-14', `Feast of St. Philip the Apostle.`],
  ['2026-11-15', `Sunday of Revelation to
Zachariah (Father of John the
Baptist). (Niram 3)`],
  ['2026-11-20', `15th Commemoration of H. G. Job
Mar Philoxenos Metropolitan. (Mount
Tabor Dayara, Pathanapuram).`],
  ['2026-11-21', `Commemorating the Entry of St.
Mary to the Temple of Jerusalem.`],
  ['2026-11-22', `Sunday of Annunciation to St.
Mary. (Niram 4)`],
  ['2026-11-24', `210th Commemoration of Malankara
Sabha Jyothis H. G. Pulikkottil Joseph
Mar Dionysius II, the founder of Old
Seminary & 30th Commemoration of
H. G. Paulose Mar Gregorios Metropolitan.
(Old Seminary, Kottayam).`],
  ['2026-11-28', `Feast of Mar Jacob Baradaeus & Mar
Dionysius Barsleebi.`],
  ['2026-11-29', `Sunday of St. Mary's Journey to
Elizabeth. (Niram 5)
Feast of Mar Jacob of Serugh.`],
  ['2026-11-30', `Feast of St. Andrew the Apostle.`],
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
  for (const [date, dayHeadingEn] of NOVEMBER_ENGLISH_BY_DATE.entries()) {
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
