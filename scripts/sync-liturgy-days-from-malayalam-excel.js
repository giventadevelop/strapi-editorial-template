'use strict';

/**
 * Sync Liturgy Day records from Liturgy-Days-Malayalam-2026.xlsx (authoritative feast dates + Malayalam).
 * - Creates missing dates for the tenant
 * - Updates dayHeadingMalylm for all Excel rows
 * - Optionally prunes DB records whose date is not in Excel (PDF parser artifacts)
 * - Optionally fills dayHeadingEn / season from liturgy-days-from-pdf.xlsx when dates match
 *
 * Run (Strapi stopped):
 *   DRY_RUN=1 node scripts/sync-liturgy-days-from-malayalam-excel.js --tenant-id=tenant_demo_002
 *   node scripts/sync-liturgy-days-from-malayalam-excel.js --tenant-id=tenant_demo_002 --prune-not-in-excel
 *
 * Options:
 *   --tenant-id=XXX          (required)
 *   --year=YYYY              Calendar year for default Excel paths (default: 2026)
 *   --excel=path             Malayalam Excel (default: Liturgy-Days-Malayalam-{year}.xlsx)
 *   --en-excel=path          English PDF export for EN/season on matching dates (default: liturgy-days-from-pdf.xlsx)
 *   --prune-not-in-excel     Delete tenant liturgy days whose date is not listed in the Malayalam Excel
 *   DRY_RUN=1                Log only; no writes
 */

const path = require('path');
const fs = require('fs');

const {
  DRY_RUN,
  getArg,
  getYear,
  getTenantId,
  hasFlag,
  resolveCalendarPaths,
  resolvePath,
} = require('./lib/liturgy-cli');

const LITURGY_DAY_UID = 'api::liturgy-day.liturgy-day';

function toDateString(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof value === 'number') {
    const date = new Date((value - 25569) * 86400 * 1000);
    return toDateString(date);
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (dmy) {
      const [, d, m, y] = dmy;
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    const ymd = s.match(/^(\d{4})[\/\-](\d{2})[\/\-](\d{2})$/);
    if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  }
  return null;
}

function readMalayalamExcel(excelPath) {
  const XLSX = require('xlsx');
  if (!fs.existsSync(excelPath)) throw new Error('Excel file not found: ' + excelPath);
  const wb = XLSX.readFile(excelPath, { cellDates: true, cellNF: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: '' });
  if (!rows.length) return [];

  const keys = Object.keys(rows[0]);
  const dateKey = keys.find((k) => k.toLowerCase() === 'date') || 'date';
  const mlKey =
    keys.find((k) => k.toLowerCase() === 'dayheadingmalylm') ||
    keys.find((k) => /dayheadingmalylm/i.test(k)) ||
    'dayHeadingMalylm';

  const byDate = new Map();
  for (const row of rows) {
    const date = toDateString(row[dateKey]);
    if (!date) continue;
    const dayHeadingMalylm = row[mlKey] != null ? String(row[mlKey]).trim() : '';
    byDate.set(date, { date, dayHeadingMalylm });
  }
  return byDate;
}

function readEnExcel(excelPath) {
  if (!excelPath || !fs.existsSync(excelPath)) return new Map();
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(excelPath, { cellDates: true });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  const byDate = new Map();
  for (const row of rows) {
    const date = toDateString(row.date);
    if (!date) continue;
    byDate.set(date, {
      dayHeadingEn: row.dayHeadingEn ? String(row.dayHeadingEn).trim() : null,
      seasonNameEn: row.seasonNameEn ? String(row.seasonNameEn).trim() : null,
      seasonNameMalylm: row.seasonNameMalylm ? String(row.seasonNameMalylm).trim() : null,
    });
  }
  return byDate;
}

function tenantFilters(tenant) {
  const docId = tenant.documentId ?? tenant.document_id;
  return docId != null
    ? { $or: [{ tenant: tenant.id }, { tenant: { documentId: docId } }] }
    : { tenant: tenant.id };
}

async function main() {
  const year = getYear();
  const paths = resolveCalendarPaths(year);
  const tenantId = getTenantId({ required: true });

  const excelPath = resolvePath(getArg('excel', paths.malayalamExcel));
  const enExcelPath = resolvePath(getArg('en-excel', paths.pdfExportExcel));
  const prune = hasFlag('prune-not-in-excel');

  const excelByDate = readMalayalamExcel(excelPath);
  const enByDate = readEnExcel(enExcelPath);
  const excelDates = new Set(excelByDate.keys());
  console.log('Malayalam Excel:', excelByDate.size, 'unique dates from', excelPath);
  console.log('EN supplement:', enByDate.size, 'dates from', enExcelPath);
  if (DRY_RUN) console.log('DRY_RUN=1: no changes will be written.');
  if (prune) console.log('Will prune tenant records not listed in Malayalam Excel.');
  console.log('');

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
  for (const doc of list) {
    const dateStr =
      typeof doc.date === 'string'
        ? doc.date.slice(0, 10)
        : doc.date?.toISOString?.()?.slice(0, 10);
    if (!dateStr) continue;
    if (!byDate.has(dateStr)) byDate.set(dateStr, []);
    byDate.get(dateStr).push(doc);
  }

  let pruned = 0;
  if (prune) {
    for (const [dateStr, docs] of byDate.entries()) {
      if (excelDates.has(dateStr)) continue;
      for (const doc of docs) {
        if (DRY_RUN) {
          console.log('Would prune', dateStr, doc.documentId);
          pruned++;
        } else {
          try {
            await app.documents(LITURGY_DAY_UID).delete({ documentId: doc.documentId });
            pruned++;
          } catch (e) {
            console.warn('Prune failed', dateStr, e.message);
          }
        }
      }
    }
    if (prune && !DRY_RUN) {
      byDate.clear();
      const again = await app.documents(LITURGY_DAY_UID).findMany({ filters, limit: 50000 });
      const againList = again?.results ?? again?.data ?? (Array.isArray(again) ? again : []);
      for (const doc of againList) {
        const dateStr =
          typeof doc.date === 'string'
            ? doc.date.slice(0, 10)
            : doc.date?.toISOString?.()?.slice(0, 10);
        if (!dateStr) continue;
        if (!byDate.has(dateStr)) byDate.set(dateStr, []);
        byDate.get(dateStr).push(doc);
      }
    }
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const sortedDates = [...excelByDate.keys()].sort();

  for (let i = 0; i < sortedDates.length; i++) {
    const date = sortedDates[i];
    const row = excelByDate.get(date);
    const en = enByDate.get(date) || {};
    const ml = row.dayHeadingMalylm || null;
    const docs = byDate.get(date);

    if (!docs || docs.length === 0) {
      const data = {
        date,
        dayHeadingMalylm: ml,
        dayHeadingEn: en.dayHeadingEn || null,
        seasonNameEn: en.seasonNameEn || null,
        seasonNameMalylm: en.seasonNameMalylm || null,
        order: i,
        readings: [],
        tenant: tenant.id,
      };
      if (DRY_RUN) {
        console.log('Would create', date, (ml || '').slice(0, 40));
        created++;
        continue;
      }
      try {
        const createdDoc = await app.documents(LITURGY_DAY_UID).create({ data });
        if (createdDoc?.documentId) {
          try {
            await app.db.query(LITURGY_DAY_UID).update({
              where: { documentId: createdDoc.documentId },
              data: { tenant: tenant.id },
            });
          } catch (_) {}
        }
        created++;
        if (created % 25 === 0) console.log('Created', created, '...');
      } catch (e) {
        console.warn('Create failed', date, e.message);
        skipped++;
      }
      continue;
    }

    for (const doc of docs) {
      const patch = { dayHeadingMalylm: ml };
      if (en.dayHeadingEn && !doc.dayHeadingEn) patch.dayHeadingEn = en.dayHeadingEn;
      if (en.seasonNameEn && !doc.seasonNameEn) patch.seasonNameEn = en.seasonNameEn;
      if (en.seasonNameMalylm && !doc.seasonNameMalylm) patch.seasonNameMalylm = en.seasonNameMalylm;

      const needsUpdate =
        doc.dayHeadingMalylm !== ml ||
        (patch.dayHeadingEn && doc.dayHeadingEn !== patch.dayHeadingEn);

      if (!needsUpdate) continue;

      if (DRY_RUN) {
        console.log('Would update', date, (ml || '').slice(0, 40));
        updated++;
        continue;
      }
      try {
        await app.documents(LITURGY_DAY_UID).update({
          documentId: doc.documentId,
          data: patch,
        });
        updated++;
        if (updated % 50 === 0) console.log('Updated', updated, '...');
      } catch (e) {
        console.warn('Update failed', date, e.message);
        skipped++;
      }
    }
  }

  console.log('');
  console.log(DRY_RUN ? 'Would prune' : 'Pruned', pruned, 'record(s) not in Excel');
  console.log(DRY_RUN ? 'Would create' : 'Created', created, 'record(s)');
  console.log(DRY_RUN ? 'Would update' : 'Updated', updated, 'record(s)');
  if (skipped) console.log('Skipped/failed', skipped);
  console.log('Excel authoritative count:', excelByDate.size);

  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
