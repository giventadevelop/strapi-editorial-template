'use strict';

/**
 * Fix April 2026 English headings for Liturgy Day entries for one tenant.
 * This script only writes date/dayHeadingEn/tenant (and order when creating missing rows).
 *
 * Run:
 *   node scripts/fix-april-english-liturgy-2026.js --tenant-id=tenant_demo_002
 *   DRY_RUN=1 node scripts/fix-april-english-liturgy-2026.js --tenant-id=tenant_demo_002
 */

const { DRY_RUN, getTenantId } = require('./lib/liturgy-cli');

const LITURGY_DAY_UID = 'api::liturgy-day.liturgy-day';

const APRIL_ENGLISH_BY_DATE = new Map([
  ['2026-04-01', `Wednesday of the Holy Week.`],
  ['2026-04-02', `Passover (Maundy Thursday).`],
  ['2026-04-03', `Holy Friday of Crucifixion.`],
  ['2026-04-04', `Gospel Saturday (Saturday of Good
Tidings).`],
  ['2026-04-05', `Kyomtho/Easter. (Evening to 1st
Kauma of Night - Niram 8; Then
Niram1)
61th Commemoration of H. G.
Kuriakose Mar Gregorios Metropolitan.
(Pampady Dayara).`],
  ['2026-04-06', `Hevoro Monday. (Niram 2)`],
  ['2026-04-07', `Hevoro Tuesday. (Niram 3)
218th Commemoration of Valiya Mar
Dionysius Metropolitan. (Marthoma VI)
(Puthencavu Cathedral).`],
  ['2026-04-08', `Hevoro Wednesday. (Niram 4)`],
  ['2026-04-09', `Hevoro Thursday. (Niram 5)`],
  ['2026-04-10', `Hevoro Friday. (Niram 6)
Commemoration of Confessors`],
  ['2026-04-11', `Hevoro Saturday. (Niram 7)`],
  ['2026-04-12', `New Sunday (First Sunday after
Easter). (Evening to 1st Kauma of
Night - Niram 8; Then Niram 1)
13th Commemoration of H. G.
Geevarghese Mar Ivanios
Metropolitan. (Mar Baselios
Dayara, Njaliakuzhy).`],
  ['2026-04-14', `330th Commemoration of Marthoma II.
(Niranam Valiyapally).`],
  ['2026-04-17', `75th Commemoration of Catholicate
Ratnadeepam H. G. Geevarghese Mar
Philoxenos Metropolitan. (Puthencavu
Cathedral).`],
  ['2026-04-19', `First Sunday after New Sunday
(Second Sunday after Easter).
(Niram 2)`],
  ['2026-04-21', `232th Commemoration of Yuhanon
Mar Ivanios Episcopa. (Chengannur Old
Syrian Church)`],
  ['2026-04-22', `338th Commemoration of Marthoma
III. (Kadampanadu St. Thomas
Cathedral).`],
  ['2026-04-23', `Feast of St. George.`],
  ['2026-04-25', `356th Commemoration of Marthoma I,
the Great. (Ankamali Cheriyapally).
Feast of Saint Mark the Evangelist.`],
  ['2026-04-26', `Second Sunday after New Sunday
(Third Sunday after Easter).
(Niram 3)`],
  ['2026-04-27', `355th Commemoration of Mar
Gregorios Abdel Jaleel Bava. (Vadakan
Paravur Church).`],
  ['2026-04-29', `Commemoration of Mar Sabor & Mar
Afroth.`],
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
  for (const [date, dayHeadingEn] of APRIL_ENGLISH_BY_DATE.entries()) {
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
