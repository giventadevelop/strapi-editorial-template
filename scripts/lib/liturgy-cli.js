'use strict';

/**
 * Shared CLI helpers for liturgy calendar scripts.
 *
 * Standard parameters (CLI flags and env fallbacks):
 *   --tenant-id / TENANT_ID / LITURGY_TENANT_ID
 *   --year / YEAR / LITURGY_YEAR
 *   --excel / LITURGY_MALAYALAM_EXCEL / LITURGY_EXCEL  (Malayalam Excel; default from year)
 *   --editor-email / LITURGY_EDITOR_EMAIL / EDITOR_EMAIL  (verify script)
 */

const path = require('path');

try {
  require('dotenv').config();
} catch (_) {}

const DEFAULT_YEAR = 2026;

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const ENV_BY_ARG = {
  'tenant-id': ['TENANT_ID', 'LITURGY_TENANT_ID'],
  tenantId: ['TENANT_ID', 'LITURGY_TENANT_ID'],
  year: ['YEAR', 'LITURGY_YEAR'],
  excel: ['LITURGY_MALAYALAM_EXCEL', 'LITURGY_EXCEL'],
  'en-excel': ['LITURGY_EN_EXCEL'],
  'en-pdf': ['LITURGY_EN_PDF'],
  'ml-pdf': ['LITURGY_ML_PDF'],
  'editor-email': ['LITURGY_EDITOR_EMAIL', 'EDITOR_EMAIL'],
  editorEmail: ['LITURGY_EDITOR_EMAIL', 'EDITOR_EMAIL'],
  limit: ['LIMIT', 'LITURGY_LIMIT'],
};

function getArg(name, defaultValue) {
  const names = Array.isArray(name) ? name : [name];
  for (const n of names) {
    for (const envKey of ENV_BY_ARG[n] || []) {
      const v = process.env[envKey];
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
  }
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    for (const n of names) {
      if (arg === `--${n}` && process.argv[i + 1]) return process.argv[i + 1].trim();
      const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = arg.match(new RegExp(`^--${escaped}=(.+)$`));
      if (match) return match[1].trim();
    }
  }
  return defaultValue;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function getYear(defaultYear = DEFAULT_YEAR) {
  const raw = getArg('year', String(defaultYear));
  const year = parseInt(raw, 10);
  if (!Number.isFinite(year)) return defaultYear;
  return Math.max(1900, Math.min(9999, year));
}

function getTenantId(options = {}) {
  const { required = false, defaultValue = null } = options;
  const tenantId = getArg(['tenant-id', 'tenantId'], defaultValue);
  if (required && !tenantId) {
    console.error('Missing --tenant-id (or TENANT_ID / LITURGY_TENANT_ID env).');
    console.error('Example: node scripts/<script>.js --tenant-id=tenant_demo_002 --year=2026');
    process.exit(1);
  }
  return tenantId;
}

function getEditorEmail() {
  const fromFlag = getArg(['editor-email', 'editorEmail'], null);
  if (fromFlag) return String(fromFlag).trim().toLowerCase();
  const positional = process.argv[2];
  if (positional && !positional.startsWith('--')) {
    return String(positional).trim().toLowerCase();
  }
  return null;
}

/** Year-based default paths under documentation/lectionary_calendar/ */
function resolveCalendarPaths(year = DEFAULT_YEAR) {
  const y = String(getYear(year));
  const yy = y.slice(-2);
  const calendarDir = path.join('documentation', 'lectionary_calendar');
  return {
    year: parseInt(y, 10),
    calendarDir,
    enPdf: path.join(calendarDir, `${y}-Liturgical-Calender.pdf`),
    mlPdf: path.join(calendarDir, `Panjangom_${yy}.pdf`),
    malayalamExcel: path.join(calendarDir, `Liturgy-Days-Malayalam-${y}.xlsx`),
    masterExcel: path.join(calendarDir, `Liturgy-Days-Master-${y}.xlsx`),
    pdfExportExcel: path.join(calendarDir, 'liturgy-days-from-pdf.xlsx'),
  };
}

function resolvePath(relativeOrAbsolute) {
  if (!relativeOrAbsolute) return relativeOrAbsolute;
  return path.isAbsolute(relativeOrAbsolute)
    ? relativeOrAbsolute
    : path.join(process.cwd(), relativeOrAbsolute);
}

function printStandardParamsHelp() {
  console.log('Standard parameters (all liturgy scripts):');
  console.log('  --tenant-id=XXX     Tenant (env: TENANT_ID, LITURGY_TENANT_ID)');
  console.log('  --year=YYYY         Calendar year (env: YEAR, LITURGY_YEAR; default: 2026)');
  console.log('  --excel=path        Malayalam Excel (env: LITURGY_MALAYALAM_EXCEL; default from year)');
  console.log('  --editor-email=...  Editor email for verify (env: LITURGY_EDITOR_EMAIL)');
  console.log('  DRY_RUN=1           Log only; no writes');
}

module.exports = {
  DEFAULT_YEAR,
  DRY_RUN,
  getArg,
  hasFlag,
  getYear,
  getTenantId,
  getEditorEmail,
  resolveCalendarPaths,
  resolvePath,
  printStandardParamsHelp,
};
