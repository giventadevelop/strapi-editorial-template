'use strict';

/**
 * Update existing Liturgy Day records with Malayalam headings from an Excel file.
 * Records must already exist (e.g. created by import-liturgy-days-from-pdf.js). This script
 * only updates the field dayHeadingMalylm for each date. Excel columns: date, dayHeadingMalylm.
 * UTF-8 / Malayalam encoding is preserved when writing to Strapi.
 *
 * Run from project root (Strapi server stopped):
 *   node scripts/update-liturgy-days-malayalam-from-excel.js --tenant-id=tenant_production_001
 *   node scripts/update-liturgy-days-malayalam-from-excel.js --tenant-id=tenant_demo_002 --excel=documentation/lectionary_calendar/Liturgy-Days-Malayalam-2026.xlsx
 *
 * Options:
 *   --tenant-id=XXX   (required) Tenant whose liturgy days to update (e.g. tenant_production_001)
 *   --excel=path      (optional) Path to Excel file; default: documentation/lectionary_calendar/Liturgy-Days-Malayalam-2026.xlsx
 *   DRY_RUN=1         (optional) Log what would be updated without writing to DB
 */

const path = require('path');
const fs = require('fs');

try {
  require('dotenv').config();
} catch (_) {}

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const DEFAULT_EXCEL = path.join('documentation', 'lectionary_calendar', 'Liturgy-Days-Malayalam-2026.xlsx');

function getArg(name, defaultValue) {
  const envMap = { tenantId: process.env.TENANT_ID };
  if (envMap[name]) return envMap[name];
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === `--${name}` && process.argv[i + 1]) return process.argv[i + 1];
    const match = arg.match(new RegExp(`^--${name}=(.+)$`));
    if (match) return match[1].trim();
  }
  return defaultValue;
}

/**
 * Normalize Excel date to YYYY-MM-DD string.
 * Handles: Date object, Excel serial number, or string (YYYY-MM-DD or DD/MM/YYYY).
 */
function toDateString(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof value === 'number') {
    // Excel serial date: days since 1899-12-30 (UTC)
    const date = new Date((value - 25569) * 86400 * 1000);
    return toDateString(date);
  }
  if (typeof value === 'string') {
    const s = value.trim();
    // Already YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // DD/MM/YYYY or D/M/YYYY
    const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (dmy) {
      const [, d, m, y] = dmy;
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    // YYYY/MM/DD
    const ymd = s.match(/^(\d{4})[\/\-](\d{2})[\/\-](\d{2})$/);
    if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  }
  return null;
}

/**
 * Read rows from Excel. Expect columns: date, dayHeadingMalylm (case-insensitive match).
 * Returns array of { date: 'YYYY-MM-DD', dayHeadingMalylm: string }.
 */
function readExcelRows(excelPath) {
  const XLSX = require('xlsx');
  if (!fs.existsSync(excelPath)) {
    throw new Error('Excel file not found: ' + excelPath);
  }
  // Read with cellDates so date cells become Date objects; file is UTF-8 by xlsx spec
  const wb = XLSX.readFile(excelPath, { cellDates: true, cellNF: false });
  const firstSheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: '' });
  if (!rows.length) return [];

  const keys = Object.keys(rows[0]);
  const dateKey = keys.find((k) => k.toLowerCase() === 'date') || keys.find((k) => /date/i.test(k)) || 'date';
  const mlKey =
    keys.find((k) => k.toLowerCase() === 'dayheadingmalylm') ||
    keys.find((k) => /dayheadingmalylm/i.test(k)) ||
    keys.find((k) => /dayheading.*malayalam/i.test(k)) ||
    'dayHeadingMalylm';

  return rows
    .map((row) => {
      const date = toDateString(row[dateKey] != null ? row[dateKey] : row['Date']);
      const dayHeadingMalylm = row[mlKey] != null ? String(row[mlKey]).trim() : '';
      return { date, dayHeadingMalylm };
    })
    .filter((r) => r.date);
}

async function main() {
  const tenantId = getArg('tenantId', getArg('tenant-id', null));
  if (!tenantId) {
    console.error('Missing --tenant-id. Example: node scripts/update-liturgy-days-malayalam-from-excel.js --tenant-id=tenant_production_001');
    process.exit(1);
  }

  const excelPath = getArg('excel', DEFAULT_EXCEL);
  const resolvedPath = path.isAbsolute(excelPath) ? excelPath : path.join(process.cwd(), excelPath);

  let rows;
  try {
    rows = readExcelRows(resolvedPath);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  if (rows.length === 0) {
    console.log('No rows with valid dates in', resolvedPath);
    process.exit(0);
  }

  console.log('Read', rows.length, 'rows from', resolvedPath);
  if (DRY_RUN) console.log('DRY_RUN=1: no changes will be written.');
  console.log('');

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
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

  const LITURGY_DAY_UID = 'api::liturgy-day.liturgy-day';
  const docId = tenant.documentId ?? tenant.document_id;
  const filters =
    docId != null
      ? { $or: [{ tenant: tenant.id }, { tenant: { documentId: docId } }] }
      : { tenant: tenant.id };

  const result = await app.documents(LITURGY_DAY_UID).findMany({
    filters,
    limit: 50000,
  });
  const list = result?.results ?? result?.data ?? (Array.isArray(result) ? result : []);
  const byDate = new Map();
  for (const doc of list) {
    const d = doc.date;
    const dateStr = typeof d === 'string' ? d.slice(0, 10) : (d && d.toISOString && d.toISOString().slice(0, 10));
    if (!dateStr) continue;
    if (!byDate.has(dateStr)) byDate.set(dateStr, []);
    byDate.get(dateStr).push(doc);
  }

  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const docs = byDate.get(row.date);
    if (!docs || docs.length === 0) {
      skipped++;
      if (rows.length <= 30) console.log('No record for date', row.date, '– skip');
      continue;
    }
    const value = row.dayHeadingMalylm || null;
    for (const doc of docs) {
      if (doc.dayHeadingMalylm === value && !DRY_RUN) continue;
      if (DRY_RUN) {
        console.log('Would update', row.date, 'documentId', doc.documentId, 'dayHeadingMalylm:', (value || '').slice(0, 50) + (value && value.length > 50 ? '…' : ''));
        updated++;
        continue;
      }
      try {
        await app.documents(LITURGY_DAY_UID).update({
          documentId: doc.documentId,
          data: { dayHeadingMalylm: value },
        });
        updated++;
        if (rows.length > 20 && updated % 50 === 0) console.log('Updated', updated, 'records');
      } catch (e) {
        console.warn('Update failed for date', row.date, doc.documentId, e.message);
      }
    }
  }

  console.log('');
  console.log(DRY_RUN ? 'Would update' : 'Updated', updated, 'liturgy day record(s) for tenant', tenantId);
  if (skipped > 0) console.log('Skipped', skipped, 'date(s) with no matching record in DB.');
  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
