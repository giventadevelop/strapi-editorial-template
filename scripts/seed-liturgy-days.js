'use strict';

/**
 * Seed liturgical calendar entries for the next several days (starting from 2026-02-27).
 * Uses tenant_demo_002. Run from project root: node scripts/seed-liturgy-days.js
 *
 * Sample format from project:
 *   Season: Great Lent / വലിയ നോമ്പ് (from Feb 16, 2026)
 *   Day headings and readings in English + Malayalam.
 */

const TENANT_ID = 'tenant_demo_002';

// Day heading (EN) and (Malayalam) for each date; season is Great Lent for this period
const DAYS = [
  { date: '2026-02-27', dayEn: 'Thursday, 27 February 2026', dayMal: 'വ്യാഴാഴ്ച, 27 ഫെബ്രുവരി 2026' },
  { date: '2026-02-28', dayEn: 'Friday, 28 February 2026', dayMal: 'വെള്ളിയാഴ്ച, 28 ഫെബ്രുവരി 2026' },
  { date: '2026-03-01', dayEn: 'Saturday, 1 March 2026', dayMal: 'ശനിയാഴ്ച, 1 മാർച്ച 2026' },
  { date: '2026-03-02', dayEn: 'Sunday, 2 March 2026', dayMal: 'ഞായറാഴ്ച, 2 മാർച്ച 2026' },
  { date: '2026-03-03', dayEn: 'Monday, 3 March 2026', dayMal: 'തിങ്കളാഴ്ച, 3 മാർച്ച 2026' },
  { date: '2026-03-04', dayEn: 'Tuesday, 4 March 2026', dayMal: 'ചൊവ്വാഴ്ച, 4 മാർച്ച 2026' },
  { date: '2026-03-05', dayEn: 'Wednesday, 5 March 2026', dayMal: 'ബുധനാഴ്ച, 5 മാർച്ച 2026' },
];

const SEASON_EN = 'Great Lent';
const SEASON_MAL = 'വലിയ നോമ്പ്';

// Sample readings (First Reading, Gospel) – same structure for each day; can be edited in admin
const DEFAULT_READINGS = [
  {
    liturgyHeadingEn: 'First Reading',
    liturgyHeadingMalylm: 'ഒന്നാം വായന',
    contentPlaceEn: 'Genesis 1:1-5',
    contentPlaceMalylm: 'ഉൽപത്തി 1:1-5',
  },
  {
    liturgyHeadingEn: 'Gospel',
    liturgyHeadingMalylm: 'സുവിശേഷം',
    contentPlaceEn: 'Matthew 4:1-11',
    contentPlaceMalylm: 'മത്തായി 4:1-11',
  },
];

async function getTenant(strapi, tenantId) {
  const tenant = await strapi.db.query('api::tenant.tenant').findOne({
    where: { tenantId },
    select: ['id', 'documentId'],
  });
  if (!tenant) {
    console.warn(`Tenant with tenantId "${tenantId}" not found. Create it in Strapi Admin (Content Manager → Tenant).`);
    return null;
  }
  return tenant;
}

async function seedLiturgyDays(strapi, tenant) {
  const existing = await strapi.documents('api::liturgy-day.liturgy-day').findMany({
    filters: { tenant: tenant.id },
    limit: 1,
  });
  const list = existing?.results ?? existing?.data ?? (Array.isArray(existing) ? existing : []);
  if (list.length > 0) {
    console.log('Liturgy days already exist for this tenant. Skipping seed to avoid duplicates.');
    console.log('Delete existing liturgy-day entries in Admin if you want to re-seed.');
    return;
  }

  for (let i = 0; i < DAYS.length; i++) {
    const day = DAYS[i];
    await strapi.documents('api::liturgy-day.liturgy-day').create({
      data: {
        date: day.date,
        dayHeadingEn: day.dayEn,
        dayHeadingMalylm: day.dayMal,
        seasonNameEn: SEASON_EN,
        seasonNameMalylm: SEASON_MAL,
        order: i,
        readings: DEFAULT_READINGS,
        tenant: tenant.id,
      },
    });
    console.log(`Created liturgy day: ${day.date} – ${day.dayEn}`);
  }
  console.log(`Created ${DAYS.length} liturgy days for tenant ${TENANT_ID}`);
}

async function main() {
  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  try {
    const tenant = await getTenant(app, TENANT_ID);
    if (tenant) await seedLiturgyDays(app, tenant);
  } finally {
    await app.destroy();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
