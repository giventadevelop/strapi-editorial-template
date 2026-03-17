'use strict';

/**
 * Export parsed liturgy days from the two PDFs to an Excel file.
 * Uses the same parser as import-liturgy-days-from-pdf.js; does not touch Strapi.
 *
 * Malayalam columns (dayHeadingMalylm, seasonNameMalylm, etc.) are styled with
 * a Malayalam font so Excel displays the script correctly. PDF extraction uses
 * disableCombineTextItems + NFC normalization to preserve Unicode (see pdf-extract.js).
 *
 * Run from project root:
 *   node scripts/export-liturgy-days-from-pdf-to-excel.js
 *   node scripts/export-liturgy-days-from-pdf-to-excel.js --year=2026
 *
 * Output: documentation/lectionary_calendar/liturgy-days-from-pdf.xlsx
 */

const path = require('path');
const fs = require('fs');

function getArg(name, defaultValue) {
  const envMap = { year: process.env.YEAR };
  if (envMap[name]) return envMap[name];
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === `--${name}` && process.argv[i + 1]) return process.argv[i + 1];
    const match = arg.match(new RegExp(`^--${name}=(.+)$`));
    if (match) return match[1].trim();
  }
  return defaultValue;
}

const DEFAULT_EN_PDF = path.join('documentation', 'lectionary_calendar', '2026-Liturgical-Calender.pdf');
const DEFAULT_ML_PDF = path.join('documentation', 'lectionary_calendar', 'Panjangom_26.pdf');

/** 0-based column indices for Malayalam fields (dayHeadingMalylm, seasonNameMalylm, readings ML). */
const MALAYALAM_COL_INDICES = [2, 4, 7, 9, 11, 13];
const MALAYALAM_FONT = 'Noto Sans Malayalam';

function colLetter(colIndex) {
  if (colIndex < 26) return String.fromCharCode(65 + colIndex);
  return String.fromCharCode(64 + Math.floor(colIndex / 26)) + String.fromCharCode(65 + (colIndex % 26));
}

function applyMalayalamStyle(ws, numRows) {
  const fontStyle = { font: { name: MALAYALAM_FONT, sz: 11 } };
  for (let r = 0; r <= numRows; r++) {
    for (const c of MALAYALAM_COL_INDICES) {
      const ref = colLetter(c) + (r + 1);
      if (ws[ref]) ws[ref].s = { ...ws[ref].s, ...fontStyle };
    }
  }
}

async function main() {
  const yearArg = getArg('year', '2026');
  const year = Math.max(1900, Math.min(9999, parseInt(yearArg, 10) || 2026));
  const enPdf = getArg('en-pdf', DEFAULT_EN_PDF);
  const mlPdf = getArg('ml-pdf', DEFAULT_ML_PDF);

  const parseLiturgyPdfs = require('./lectionary-pdf-parser');
  const { days, stats } = await parseLiturgyPdfs(enPdf, mlPdf, year);
  if (!days || days.length === 0) {
    console.log('No liturgy days parsed from PDFs.');
    process.exit(0);
    return;
  }

  const XLSX = require('xlsx-js-style');
  const outDir = path.join(process.cwd(), 'documentation', 'lectionary_calendar');
  const outPath = path.join(outDir, 'liturgy-days-from-pdf.xlsx');

  const headers = [
    'date',
    'dayHeadingEn',
    'dayHeadingMalylm',
    'seasonNameEn',
    'seasonNameMalylm',
    'order',
    'reading1_liturgyHeadingEn',
    'reading1_liturgyHeadingMalylm',
    'reading1_contentPlaceEn',
    'reading1_contentPlaceMalylm',
    'reading2_liturgyHeadingEn',
    'reading2_liturgyHeadingMalylm',
    'reading2_contentPlaceEn',
    'reading2_contentPlaceMalylm',
  ];

  const rows = days.map((d, i) => [
    d.date,
    d.dayHeadingEn || '',
    d.dayHeadingMalylm || '',
    d.seasonNameEn || '',
    d.seasonNameMalylm || '',
    i,
    '', '', '', '',
    '', '', '', '',
  ]);

  const wsData = [headers, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  applyMalayalamStyle(ws, rows.length);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Liturgy Days');

  fs.mkdirSync(outDir, { recursive: true });
  XLSX.writeFile(wb, outPath);

  console.log('Parser stats: EN entries=', stats.enCount, 'ML entries=', stats.mlCount, 'merged days=', stats.mergedCount);
  console.log('Written', days.length, 'rows to', outPath, '(Malayalam columns use', MALAYALAM_FONT + ')');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
