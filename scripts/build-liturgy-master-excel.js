'use strict';

/**
 * Build Liturgy-Days-Master-{year}.xlsx merging Malayalam Excel + PDF export English columns.
 *
 * Run:
 *   node scripts/build-liturgy-master-excel.js --year=2026
 *   node scripts/build-liturgy-master-excel.js --year=2026 --excel=documentation/lectionary_calendar/Liturgy-Days-Malayalam-2026.xlsx
 *
 * Options:
 *   --year=YYYY       Calendar year (default: 2026; env: YEAR, LITURGY_YEAR)
 *   --excel=path      Malayalam Excel (default: Liturgy-Days-Malayalam-{year}.xlsx)
 *   --en-excel=path   English PDF export (default: liturgy-days-from-pdf.xlsx)
 *   --out=path        Output master file (default: Liturgy-Days-Master-{year}.xlsx)
 */

const path = require('path');
const fs = require('fs');
const {
  getArg,
  getYear,
  resolveCalendarPaths,
  resolvePath,
} = require('./lib/liturgy-cli');

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
  }
  return null;
}

async function main() {
  const year = getYear();
  const paths = resolveCalendarPaths(year);
  const XLSX = require('xlsx-js-style');
  const mlPath = resolvePath(getArg('excel', paths.malayalamExcel));
  const enPath = resolvePath(getArg('en-excel', paths.pdfExportExcel));
  const outPath = resolvePath(getArg('out', paths.masterExcel));

  const mlWb = XLSX.readFile(mlPath, { cellDates: true });
  const mlRows = XLSX.utils.sheet_to_json(mlWb.Sheets[mlWb.SheetNames[0]]);
  const mlByDate = new Map();
  for (const r of mlRows) {
    const d = toDateString(r.date);
    if (d) mlByDate.set(d, String(r.dayHeadingMalylm || '').trim());
  }

  const enByDate = new Map();
  if (fs.existsSync(enPath)) {
    const enWb = XLSX.readFile(enPath, { cellDates: true });
    for (const r of XLSX.utils.sheet_to_json(enWb.Sheets[enWb.SheetNames[0]])) {
      const d = toDateString(r.date);
      if (d) enByDate.set(d, r);
    }
  }

  const dates = [...mlByDate.keys()].sort();
  const rows = dates.map((date, order) => {
    const en = enByDate.get(date) || {};
    return {
      date,
      dayHeadingEn: en.dayHeadingEn || '',
      dayHeadingMalylm: mlByDate.get(date) || '',
      seasonNameEn: en.seasonNameEn || '',
      seasonNameMalylm: en.seasonNameMalylm || '',
      order,
    };
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `Liturgy Days ${year}`);
  XLSX.writeFile(wb, outPath);
  console.log('Wrote', rows.length, 'rows to', outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
