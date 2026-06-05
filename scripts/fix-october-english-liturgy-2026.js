'use strict';

/**
 * Fix October 2026 English headings for Liturgy Day entries for one tenant.
 * This script only writes date/dayHeadingEn/tenant (and order when creating missing rows).
 *
 * Run:
 *   node scripts/fix-october-english-liturgy-2026.js --tenant-id=tenant_demo_002
 *   DRY_RUN=1 node scripts/fix-october-english-liturgy-2026.js --tenant-id=tenant_demo_002
 */

const { DRY_RUN, getTenantId } = require('./lib/liturgy-cli');

const LITURGY_DAY_UID = 'api::liturgy-day.liturgy-day';

const OCTOBER_ENGLISH_BY_DATE = new Map([
  ['2026-10-01', `Feast of Evangelist Adai, Abahai the
Martyr & Mar Malke.`],
  ['2026-10-02', `138th Commemoration of Karottu
veettil Shemavoon Mar Dionysius.
(Kadungamangalam Church).`],
  ['2026-10-03', `341th Feast of St. Baselios Yeldho
Catholicos. (Kothamangalam
Cheriyapally).`],
  ['2026-10-04', `Third Sunday after the feast of
the Holy Cross. (Niram 3)
Seminary Day.`],
  ['2026-10-07', `Feast of Martyrs Sargis & Bakos.`],
  ['2026-10-11', `Fourth Sunday after the feast
of the Holy Cross. (Niram 4)`],
  ['2026-10-12', `171th Commemoration of H. G.
Cheppad Philipos Mar Dionysius IV
Metropolitan. (Cheppad Church).
46th Commemoration of H. G.
Yuhannon Mar Athanasios Episcopa.
(Bethany Ashram, Ranni-Perunadu).`],
  ['2026-10-14', `Commemoration of St. Athanasios
of Alexandria.`],
  ['2026-10-15', `5th Anniversary of the Enthron
ement of H. H. Baselios Marthoma
Mathews III Catholicos.
Feast of St. Osyo the Ascetic.`],
  ['2026-10-18', `Fifth Sunday after the feast of
the Holy Cross. (Niram 5)
Feast of St. Luke the Evangelist.`],
  ['2026-10-22', `262th Commemoration of H. H. Mar
Baselios Shakralla. (Kandanadu
Cathedral).
Feast of St. James the Apostle, Son
of Alphaeus.`],
  ['2026-10-24', `9th Commemoration of H. G.
Zachariah Mar Theophilos Metropolitan.
(Thadagam
Coimbatore).`],
  ['2026-10-25', `Sixth Sunday after the feast of
the Holy Cross. (Niram 6)`],
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
  for (const [date, dayHeadingEn] of OCTOBER_ENGLISH_BY_DATE.entries()) {
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
