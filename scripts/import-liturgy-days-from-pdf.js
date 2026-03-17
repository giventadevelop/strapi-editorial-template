'use strict';

/**
 * Bulk import Liturgy Day entries from English and Malayalam PDFs.
 * Import is tenant-specific: all created entries get the given --tenant-id.
 * Editors see them in Content Manager only if they are mapped to that tenant
 * (Editor Tenant Assignment). Run assign-editor-to-directory-tenant.js with
 * TENANT_ID=<same-tenant> after import so the editor sees the list.
 *
 * Run from project root:
 *   node scripts/import-liturgy-days-from-pdf.js --tenant-id=tenant_demo_002 --year=2026
 *   node scripts/import-liturgy-days-from-pdf.js --dump-text   (extract raw text for debugging)
 *
 * Options:
 *   --tenant-id=XXX            (required for import; e.g. tenant_demo_002)
 *   --year=YYYY                (calendar year for parsed dates, default: 2026)
 *   --split-en-headings         (split dayHeadingEn by sentences; one entry per sentence, same date)
 *   --limit=N                  (create at most N entries)
 *   DRY_RUN=1                  (log parsed days, do not create)
 *   --en-pdf=path              (default: documentation/lectionary_calendar/2026-Liturgical-Calender.pdf)
 *   --ml-pdf=path              (default: documentation/lectionary_calendar/Panjangom_26.pdf)
 */

const path = require('path');
const fs = require('fs');

try {
  require('dotenv').config();
} catch (_) {}

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const DEFAULT_EN_PDF = path.join('documentation', 'lectionary_calendar', '2026-Liturgical-Calender.pdf');
const DEFAULT_ML_PDF = path.join('documentation', 'lectionary_calendar', 'Panjangom_26.pdf');

function getArg(name, defaultValue) {
  const envMap = {
    tenantId: process.env.TENANT_ID,
    limit: process.env.LIMIT,
    year: process.env.YEAR,
  };
  if (envMap[name]) return envMap[name];
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === `--${name}` && process.argv[i + 1]) return process.argv[i + 1];
    const match = arg.match(new RegExp(`^--${name}=(.+)$`));
    if (match) return match[1].trim();
  }
  return defaultValue;
}

function getDumpText() {
  return process.argv.includes('--dump-text');
}

function getSplitEnHeadings() {
  return process.argv.includes('--split-en-headings');
}

/** Split English heading into sentences (period + space). Returns array of trimmed strings. */
function splitEnHeadingIntoSentences(text) {
  if (!text || typeof text !== 'string') return [''];
  const trimmed = text.trim();
  if (!trimmed) return [''];
  const parts = trimmed.split(/(?<=\.)\s+/).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : [trimmed];
}

async function dumpText(enPdf, mlPdf) {
  const { extractPdfText } = require('./lectionary/pdf-extract');
  const outDir = path.join(process.cwd(), 'documentation', 'lectionary_calendar');
  fs.mkdirSync(outDir, { recursive: true });

  console.log('Extracting English PDF:', enPdf);
  const en = await extractPdfText(enPdf);
  const enOut = path.join(outDir, 'dumped-en.txt');
  fs.writeFileSync(enOut, en.text, 'utf8');
  console.log('  Pages:', en.numPages, '->', enOut);

  console.log('Extracting Malayalam PDF:', mlPdf);
  const ml = await extractPdfText(mlPdf);
  const mlOut = path.join(outDir, 'dumped-ml.txt');
  fs.writeFileSync(mlOut, ml.text, 'utf8');
  console.log('  Pages:', ml.numPages, '->', mlOut);

  console.log('\nDone. Inspect the .txt files to design the parser.');
}

async function main() {
  const tenantId = getArg('tenantId', 'tenant_demo_002');
  const limitArg = getArg('limit', '');
  const limit = limitArg ? Math.max(0, parseInt(limitArg, 10)) : null;
  const yearArg = getArg('year', '2026');
  const year = Math.max(1900, Math.min(9999, parseInt(yearArg, 10) || 2026));
  const enPdf = getArg('en-pdf', DEFAULT_EN_PDF);
  const mlPdf = getArg('ml-pdf', DEFAULT_ML_PDF);

  if (getDumpText()) {
    await dumpText(enPdf, mlPdf);
    process.exit(0);
    return;
  }

  const parseLiturgyPdfs = require('./lectionary-pdf-parser');
  let { days, stats } = await parseLiturgyPdfs(enPdf, mlPdf, year);
  if (!days || days.length === 0) {
    console.log('No liturgy days parsed from PDFs.');
    process.exit(0);
    return;
  }

  if (getSplitEnHeadings()) {
    const expanded = [];
    for (const d of days) {
      const sentences = splitEnHeadingIntoSentences(d.dayHeadingEn);
      for (let i = 0; i < sentences.length; i++) {
        expanded.push({
          ...d,
          dayHeadingEn: sentences[i],
          dayHeadingMalylm: i === 0 ? (d.dayHeadingMalylm || '') : '',
        });
      }
    }
    days = expanded;
    console.log('Split EN headings: expanded to', days.length, 'entries (one per sentence, same date where multiple).');
  }

  const toCreate = limit != null ? days.slice(0, limit) : days;
  console.log('Parser stats: EN entries=', stats.enCount, 'ML entries=', stats.mlCount, 'merged days=', stats.mergedCount);
  console.log('Will', DRY_RUN ? 'log' : 'create', toCreate.length, 'liturgy days.\n');

  if (DRY_RUN) {
    toCreate.slice(0, 5).forEach((d, i) => console.log(i + 1, d.date, d.dayHeadingEn || d.dayHeadingMalylm || '(no heading)'));
    if (toCreate.length > 5) console.log('...');
    process.exit(0);
    return;
  }

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  const tenant = await app.db.query('api::tenant.tenant').findOne({
    where: { tenantId },
    select: ['id', 'documentId'],
  });
  if (!tenant) {
    console.error('Tenant not found:', tenantId);
    process.exit(1);
  }
  // Use tenant.id so the relation is stored the same way as seed-liturgy-days and
  // document API filters (tenant: tenant.id) find these entries.
  const LITURGY_DAY_UID = 'api::liturgy-day.liturgy-day';
  let created = 0;
  for (let i = 0; i < toCreate.length; i++) {
    const day = toCreate[i];
    const data = {
      date: day.date,
      dayHeadingEn: day.dayHeadingEn || null,
      dayHeadingMalylm: day.dayHeadingMalylm || null,
      seasonNameEn: day.seasonNameEn || null,
      seasonNameMalylm: day.seasonNameMalylm || null,
      order: i,
      readings: day.readings && day.readings.length ? day.readings : [],
      tenant: tenant.id,
    };
    // Console output (copy-pasteable) so you can see exactly what is inserted
    console.log('--- Record', i + 1, '| date:', day.date, '---');
    console.log(JSON.stringify({
      date: data.date,
      dayHeadingEn: data.dayHeadingEn,
      dayHeadingMalylm: data.dayHeadingMalylm,
      seasonNameEn: data.seasonNameEn,
      seasonNameMalylm: data.seasonNameMalylm,
      order: data.order,
      readings: data.readings,
    }, null, 2));
    console.log('');
    try {
      const createdDoc = await app.documents(LITURGY_DAY_UID).create({ data });
      created++;
      // Document Service may not persist manyToOne relation; set tenant via entity table so filters find it.
      if (createdDoc?.documentId != null) {
        try {
          await app.db.query(LITURGY_DAY_UID).update({
            where: { documentId: createdDoc.documentId },
            data: { tenant: tenant.id },
          });
        } catch (e2) {
          console.warn('  Set tenant relation failed:', day.date, e2.message);
        }
      }
      if (toCreate.length > 10 && created % 50 === 0) console.log('Created', created, '/', toCreate.length);
    } catch (e) {
      console.warn('  Create failed:', day.date, e.message);
    }
  }
  console.log('Created', created, 'liturgy days for tenant', tenantId);
  console.log('');
  console.log('To see these in Content Manager as an editor, assign that editor to this tenant:');
  console.log('  node scripts/assign-editor-to-directory-tenant.js <editor-email> ' + tenantId);
  console.log('Example: node scripts/assign-editor-to-directory-tenant.js mosc.regular.user@keleno.com ' + tenantId);
  console.log('Then have the editor log out and log back in. Verify with: node scripts/verify-editor-tenant-liturgy.js <editor-email>');
  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
