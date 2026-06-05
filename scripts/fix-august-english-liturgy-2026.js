'use strict';

/**
 * Fix August 2026 English headings for Liturgy Day entries for one tenant.
 * This script only writes date/dayHeadingEn/tenant (and order when creating missing rows).
 *
 * Run:
 *   node scripts/fix-august-english-liturgy-2026.js --tenant-id=tenant_demo_002
 *   DRY_RUN=1 node scripts/fix-august-english-liturgy-2026.js --tenant-id=tenant_demo_002
 */

const { DRY_RUN, getTenantId } = require('./lib/liturgy-cli');

const LITURGY_DAY_UID = 'api::liturgy-day.liturgy-day';

const AUGUST_ENGLISH_BY_DATE = new Map([
  ['2026-08-01', `Beginning of Assumption (Shoonoyo)
Fast (15 days).
Feast of Martyrs Marth Shmuni, her
7 children and Eliazar their teacher.
14th Commemoration of H. G. Paulose
Mar Pachomios Metropolitan (Bethany
Ashram, Ranni Perunad).`],
  ['2026-08-02', `Tenth Sunday after Pentecost.
(Niram 1)`],
  ['2026-08-06', `The festival of Transfiguration
(Koodara Perunal). (Niram 6)
61th Commemoration of Malankar
ayude Dharmayogy H. G. Alexios Mar
Theodosios Metropolitan. (Bethany
Ashram, Ranni-Perunad).`],
  ['2026-08-07', `Feast of St. Demetrios of Thessel
onica.
Commemoration of Yathivaryan Fr.
Younan (Anchal Achen).`],
  ['2026-08-09', `First Sunday after the Transfigu
ration. (Niram 8)`],
  ['2026-08-12', `Feast of St. Azazayel the Martyr.`],
  ['2026-08-13', `Commemoration of Prophet Micha.`],
  ['2026-08-15', `Festival of the Ascension of St. Mary
(Shoonoyo Perunal). (Niram 7)
Indian Independence Day.
111th Commemoration of Patriarch
Mar Ignatios Abded Meshiha II.
(Kurkuma Dayara).
Martha Mariam Samajam day.
Kottayam Devalokam Catholicate
Aramana Chapel Perunal.`],
  ['2026-08-16', `First Sunday after the feast of
the Ascension of St. Mary.
(Niram 1)
333th Commemoration of Mar Ivanios
Hidayatulla Episcopa (Mulanthuruthy
Cathedral).`],
  ['2026-08-19', `Feast of All Prophets.
Feast of St. Labbaeus (Thaddeus)
the Apostle.
35th Commemoration of H. G. Joseph
Mar Pachomios Metropolitan
(Carmelkunnu Pally, Mulakkulam).`],
  ['2026-08-20', `3rd Commemoration of H. G.
Zachariah Mar Anthonios Metropolitan
(Mount Horeb Ashram, Shastam
kotta).
Commemoration of Prophet Samuel.`],
  ['2026-08-23', `Second Sunday after the feast
of the Ascension of St. Mary.
(Niram 2)`],
  ['2026-08-24', `8th Commemoration of H. G. Thomas
Mar Athanasios Metropolitan (St.
George Dayara, Othera).
Feast of St. Matthias the Apostle.`],
  ['2026-08-29', `Feast of the Beheading of St. John
the Baptist.`],
  ['2026-08-30', `Third Sunday after the feast of
the Ascension of St. Mary.
(Niram 3)`],
  ['2026-08-31', `46th Commemoration of H. G. Paret
Mathews Mar Ivanios Metropolitan
(Mar Kuriakose Dayara, Pampady).`],
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
  for (const [date, dayHeadingEn] of AUGUST_ENGLISH_BY_DATE.entries()) {
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
