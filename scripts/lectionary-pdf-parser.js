'use strict';

/**
 * Parse English and Malayalam liturgical calendar PDFs into liturgy-day records.
 * Both PDFs use the same structure: lines like "1. Description" (day of month + description).
 * Month is inferred from order (day 1 starts a new month). Year is passed in (default 2026).
 */

const path = require('path');
const { extractPdfText } = require('./lectionary/pdf-extract');

const MONTH_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

function toIsoDate(year, month1Based, day) {
  if (year == null || month1Based == null || day == null) return null;
  const m = String(month1Based).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}`;
}

/**
 * Preprocess lines: PDF often breaks day numbers across lines.
 * - "11. First" -> "1" + "1. First" => merge to "11. First"
 * - "1. Commemoration" -> "1" + ".  Commemoration" => merge to "1.  Commemoration" (so we get Feb 1)
 */
function mergeBrokenDayLines(lines) {
  const dayLineRe = /^(\d{1,2})\.\s*(.*)$/;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const digitOnly = /^(\d{1,2})$/.exec(line);
    if (digitOnly && i + 1 < lines.length) {
      const next = lines[i + 1];
      const nextMatch = next && next.match(dayLineRe);
      if (nextMatch) {
        const first = parseInt(digitOnly[1], 10);
        const second = parseInt(nextMatch[1], 10);
        const mergedDay = first * 10 + second;
        if (mergedDay >= 1 && mergedDay <= 31) {
          out.push(mergedDay + '. ' + (nextMatch[2] || '').trim());
          i++;
          continue;
        }
      }
      // "1" + ".  Commemoration of all the..." => "1.  Commemoration..." (fix Feb 1 in EN)
      const dotStart = next && /^\.\s+(.+)$/.exec(next);
      if (digitOnly[1] === '1' && dotStart) {
        out.push('1.  ' + dotStart[1].trim());
        i++;
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Extract entries from PDF text. Lines like "1. Description" or "15. First Sunday..."
 * Continuation lines (no leading "N. ") are appended to the previous entry.
 */
function extractEntriesFromText(text, defaultYear = 2026) {
  const entries = [];
  const rawLines = text.split(/\r?\n/).map((l) => l.trim());
  const lines = mergeBrokenDayLines(rawLines);
  let currentMonth = 1;
  let lastDay = 0;

  const dayLineRe = /^(\d{1,2})\.\s*(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const match = line.match(dayLineRe);
    if (match) {
      const day = parseInt(match[1], 10);
      let desc = (match[2] || '').trim();

      if (day >= 1 && day <= 31) {
        if (day === 1 && lastDay > 1) currentMonth++;
        lastDay = day;
        const date = toIsoDate(defaultYear, currentMonth, day);
        if (date) entries.push({ date, text: desc, season: '' });
      }
    } else if (entries.length > 0 && line.length > 0 && !/^\d+\./.test(line)) {
      const last = entries[entries.length - 1];
      last.text = (last.text + ' ' + line).trim();
    }
  }
  return entries;
}

/**
 * Merge EN and ML entries by date. Both lists should have same dates in same order; merge by date key.
 */
function mergeByDate(enEntries, mlEntries) {
  const byDate = new Map();
  for (const e of enEntries) {
    byDate.set(e.date, {
      date: e.date,
      dayHeadingEn: e.text,
      seasonNameEn: e.season || '',
      dayHeadingMalylm: '',
      seasonNameMalylm: '',
      readings: [],
    });
  }
  for (const m of mlEntries) {
    const existing = byDate.get(m.date);
    if (existing) {
      existing.dayHeadingMalylm = m.text;
      existing.seasonNameMalylm = m.season || '';
    } else {
      byDate.set(m.date, {
        date: m.date,
        dayHeadingEn: '',
        dayHeadingMalylm: m.text,
        seasonNameEn: '',
        seasonNameMalylm: m.season || '',
        readings: [],
      });
    }
  }
  const sorted = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return sorted.map(([, v]) => v);
}

function truncate(str, maxLen = 500) {
  if (str == null || typeof str !== 'string') return '';
  return str.length <= maxLen ? str : str.slice(0, maxLen);
}

/** Extract season code from heading text. EN: "(Niram 2)". ML: "(\ndw 2)" (backslash-n-d-w). */
function extractSeasonFromText(text, isEn) {
  if (text == null || typeof text !== 'string') return '';
  const niramMatch = text.match(/\(Niram\s*(\d+)\)/i);
  if (niramMatch) return 'Niram ' + niramMatch[1];
  if (!isEn) {
    const ndwMatch = text.match(/\(\\ndw\s*(\d+)\)/);
    if (ndwMatch) return 'Niram ' + ndwMatch[1];
  }
  return '';
}

async function parseLiturgyPdfs(enPdfPath, mlPdfPath, year = 2026) {
  const cwd = process.cwd();
  const enPath = path.isAbsolute(enPdfPath) ? enPdfPath : path.join(cwd, enPdfPath);
  const mlPath = path.isAbsolute(mlPdfPath) ? mlPdfPath : path.join(cwd, mlPdfPath);

  const [enData, mlData] = await Promise.all([extractPdfText(enPath), extractPdfText(mlPath)]);

  const parsedYear = year != null && year >= 1900 && year <= 9999 ? year : 2026;
  const enEntries = extractEntriesFromText(enData.text, parsedYear);
  const mlEntries = extractEntriesFromText(mlData.text, parsedYear);

  const merged = mergeByDate(enEntries, mlEntries);

  const days = merged.map((row) => {
    const headingEn = truncate(row.dayHeadingEn);
    const headingMl = truncate(row.dayHeadingMalylm);
    const seasonEn = row.seasonNameEn || extractSeasonFromText(row.dayHeadingEn || '', true);
    const seasonMl = row.seasonNameMalylm || extractSeasonFromText(row.dayHeadingMalylm || '', false);
    return {
      date: row.date,
      dayHeadingEn: headingEn,
      dayHeadingMalylm: headingMl,
      seasonNameEn: truncate(seasonEn) || null,
      seasonNameMalylm: truncate(seasonMl) || null,
      readings: row.readings || [],
    };
  });

  return { days, stats: { enCount: enEntries.length, mlCount: mlEntries.length, mergedCount: merged.length } };
}

module.exports = parseLiturgyPdfs;
