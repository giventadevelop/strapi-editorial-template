'use strict';

/**
 * Fix May 2026 English headings for Liturgy Day entries for one tenant.
 * This script only writes date/dayHeadingEn/tenant (and order when creating missing rows).
 *
 * Run:
 *   node scripts/fix-may-english-liturgy-2026.js --tenant-id=tenant_demo_002
 *   DRY_RUN=1 node scripts/fix-may-english-liturgy-2026.js --tenant-id=tenant_demo_002
 */

const { DRY_RUN, getTenantId } = require('./lib/liturgy-cli');

const LITURGY_DAY_UID = 'api::liturgy-day.liturgy-day';

const MAY_ENGLISH_BY_DATE = new Map([
  ['2026-05-01', `Commemoration of St. James the
Apostle. (Son of Zebedee).`],
  ['2026-05-03', `Third Sunday after New Sunday
(Fourth Sunday after Easter).
(Niram 4)
113th Commemoration of H. H.
Baselios Paulose I Catholicos.
(Pampakuda
Cheriyapally).`],
  ['2026-05-08', `Feast of St. John the Apostle.
261th Commemoration of Marthoma V.
(Niranam Valiyapally).`],
  ['2026-05-10', `Fourth Sunday after New Sunday
(Fifth Sunday after Easter).
(Niram 5)
Feast of St. Simon the Zealot.`],
  ['2026-05-14', `Ascension of our Lord (Suloqo).
(Niram 5)`],
  ['2026-05-15', `Feast of St. Mary for Good Crops &
Harvest.
Commemoration of St. Isaac.
15-23. The Days of Preparation to
Pentecost.`],
  ['2026-05-16', `36th Commemoration of H. G.
Yuhanon Mar Severios Metropolitan.
(Zion Seminary, Koratty).`],
  ['2026-05-17', `Fifth Sunday after New Sunday
(Sixth Sunday after Easter 
Sunday before
Pentecost). (Niram 6)
Sunday School Day.`],
  ['2026-05-19', `201th Commemoration of H. G. Mar
Dionysius III (Punnathra)Metropolitan.
(Kottayam Cheriyapally).`],
  ['2026-05-20', `Commemoration of the King
Constantine and Helen the Queen.
Commemoration of the 4 Evangelists
& All fathers of the 3 Ecumenical
Synods.`],
  ['2026-05-24', `Pentecost Sunday. (Niram 7)`],
  ['2026-05-25', `Commemoration of St. Aaron the
Monk.`],
  ['2026-05-26', `12th Commemoration of H. H. Baselios
Marthoma Didymus I Catholicos.
(Mount Tabor Dayara,Pathanapuram).`],
  ['2026-05-29', `Golden Friday (Friday after
Pentecost).`],
  ['2026-05-31', `First Sunday after Pentecost.
(Niram 8)`],
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
  for (const [date, dayHeadingEn] of MAY_ENGLISH_BY_DATE.entries()) {
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
