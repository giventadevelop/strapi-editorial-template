'use strict';

/**
 * Fix March 2026 English headings for Liturgy Day entries for one tenant.
 * This script only writes date/dayHeadingEn/tenant (and order when creating missing rows).
 *
 * Run:
 *   node scripts/fix-march-english-liturgy-2026.js --tenant-id=tenant_demo_002
 *   DRY_RUN=1 node scripts/fix-march-english-liturgy-2026.js --tenant-id=tenant_demo_002
 */

const { DRY_RUN, getTenantId } = require('./lib/liturgy-cli');

const LITURGY_DAY_UID = 'api::liturgy-day.liturgy-day';

const MARCH_ENGLISH_BY_DATE = new Map([
  ['2026-03-01', `Third Sunday of Great Lent (Palsy
Sunday). (Niram 3)`],
  ['2026-03-08', `Fourth Sunday of Great Lent
(Canaanite woman). (Niram 4)`],
  ['2026-03-09', `Memory of Forty Martyrs of Sebastia.
135th Commemoration of Ambattu
Geevarghese Mar Coorilos Metropolitan.
(Angamaly Cheriyapally).`],
  ['2026-03-11', `Mid Lent. (Niram 8)
Commemoration of King Abgar of
Uraha.`],
  ['2026-03-15', `Fifth Sunday of Great Lent
(Kphiphtho/Crippled woman).
(Niram 5)`],
  ['2026-03-18', `64th Commemoration of H. G. Paulose
Mar Severios Metropolitan,Mulayirickal.
(Kunnamkulam Arthat Puthen Pally).`],
  ['2026-03-19', `96th Commemoration of H. G. Sleeba
Mar Osthathios Metropolitan.
(Kunnamkulam Arthat Puthen Pally).`],
  ['2026-03-21', `141th Commemoration of Konattu
Geevarghese Mar Julius Metropolitan.
(Pampakuda Valiyapally).`],
  ['2026-03-22', `Sixth Sunday of Great Lent (Blind
Man). (Niram 6)
Malankara Orthodox Church Day
Catholicate Day.`],
  ['2026-03-25', `Annunciation to St. Mary,
Vachanippu (Suboro). (Niram 4)
298th Commemoration of Marthoma
IV. (Kandanadu Cathedral).`],
  ['2026-03-27', `40th Friday. (Niram 2)`],
  ['2026-03-28', `Lazarus' Saturday. (Niram 8)`],
  ['2026-03-29', `Hosanna/Palm Sunday (Boys' and
Girls' Day). (Niram 7)`],
  ['2026-03-30', `Monday of the Holy Week.`],
  ['2026-03-31', `Tuesday of the Holy Week.`],
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
  for (const [date, dayHeadingEn] of MARCH_ENGLISH_BY_DATE.entries()) {
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
