'use strict';

/**
 * One-off: write liturgy day data extracted from UI screenshots to Excel.
 * Output: documentation/lectionary_calendar/liturgy-days-extract.xlsx
 */

const path = require('path');
const XLSX = require('xlsx');

const outDir = path.join(process.cwd(), 'documentation', 'lectionary_calendar');
const outPath = path.join(outDir, 'liturgy-days-extract.xlsx');

// Data extracted from attached images (2026-02-28, EN + ML views)
const row = {
  date: '2026-02-28',
  dayHeadingEn: 'Second Saturday of the Great Fast',
  dayHeadingMalylm: 'നോമ്പ് രണ്ടാം ശനി',
  seasonNameEn: 'Season of Lent',
  seasonNameMalylm: 'നോമ്പുകാലം',
  order: 0,
  reading1_liturgyHeadingEn: 'He counted as loss everything for the sake of Christ',
  reading1_liturgyHeadingMalylm: 'മിശിഹായെപ്രതി സകലതും നഷ്ടപ്പെടുത്തി.',
  reading1_contentPlaceEn: 'Phil 3:4-11',
  reading1_contentPlaceMalylm: 'ഫിലി 3:4-11',
  reading2_liturgyHeadingEn: 'Give up everything and follow Christ',
  reading2_liturgyHeadingMalylm: 'സർവവും ഉപേക്ഷിച്ച് മിശിഹായെ അനുഗമിച്ചവർ.',
  reading2_contentPlaceEn: 'Lk 5:1-11',
  reading2_contentPlaceMalylm: 'ലൂക്കാ 5:1-11',
};

const headers = Object.keys(row);
const wsData = [headers, headers.map((h) => row[h])];
const ws = XLSX.utils.aoa_to_sheet(wsData);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Liturgy Days');

require('fs').mkdirSync(outDir, { recursive: true });
XLSX.writeFile(wb, outPath);
console.log('Written:', outPath);
