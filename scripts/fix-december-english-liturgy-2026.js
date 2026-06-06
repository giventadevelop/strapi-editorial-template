'use strict';

/**
 * Fix December 2026 English headings for Liturgy Day entries for one tenant.
 * This script only writes date/dayHeadingEn/tenant (and order when creating missing rows).
 *
 * Run:
 *   node scripts/fix-december-english-liturgy-2026.js --tenant-id=tenant_demo_002
 *   DRY_RUN=1 node scripts/fix-december-english-liturgy-2026.js --tenant-id=tenant_demo_002
 */

const { DRY_RUN, getTenantId } = require('./lib/liturgy-cli');

const LITURGY_DAY_UID = 'api::liturgy-day.liturgy-day';

const DECEMBER_ENGLISH_BY_DATE = new Map([
  ['2026-12-01', `Beginning of the Fast of the Nativity
(25 days Fast).`],
  ['2026-12-03', `54th Commemoration of H. G. Thoma
Mar Dionysius Metropolitan. (Mount
Tabor Dayara, Pathanapuram).`],
  ['2026-12-04', `Feast of the Martyrs Marth Barbara
and Marth Juliana.`],
  ['2026-12-06', `Sunday of Birth of John the
Baptist (Children's Day). (Niram 6)
Intercession Day.
Feast of St. Sokhe, Bishop of Myre.
(St. Nikolas, Christmas Father).`],
  ['2026-12-08', `51th Commemoration of H. H.
Baselios Augen I Catholicos.
(Catholicate Aramana, Devalokam).`],
  ['2026-12-09', `14th Commemoration of H. G.
Mathews Mar Barnabas Metropolitan.
(St. Peter's & St. Paul's Church,
Valayanchirangara).`],
  ['2026-12-10', `Feast of the Martyrs, St. Behanam,
his sister, St. Sarah, and Co-Martyrs.
Feast of Mar Philoxenos of Mabugh.`],
  ['2026-12-13', `Sunday of Revelation to St.
Joseph. (Niram 7)
36th Commemoration of H. G. Daniel
Mar Philoxenos Metropolitan. (Basil
Aramana,
Pathanamthitta).`],
  ['2026-12-17', `98th Commemoration of H. H Baselios
Geevarghese I Catholicos (Vallikattu
Dayara, Vakathanam).`],
  ['2026-12-18', `Feast of St. Thomas the Apostle
(Commemoration of the Day he was
stabbed by Spear).`],
  ['2026-12-20', `Sunday before Christmas. (Niram 8)
Feast of Mar Ignatius Nourono of
Antioch.`],
  ['2026-12-21', `Dukhrono of St. Thomas the Apostle.`],
  ['2026-12-25', `Yeldho, Incarnation of our Lord.
(Christmas). (Niram 1)`],
  ['2026-12-26', `Feast of the Exultation of St. Mary,
Mother of God. (Niram 1)
40th Commemoration of H. G. Yakob
Mar Policarpos Metropolitan. (Zion
Seminary, Koratty).`],
  ['2026-12-27', `First Sunday after Christmas.
(Niram 1)
Feast Commemorating the Slaughter
of the Infants.`],
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
  for (const [date, dayHeadingEn] of DECEMBER_ENGLISH_BY_DATE.entries()) {
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
