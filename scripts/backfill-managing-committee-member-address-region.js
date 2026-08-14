'use strict';

/**
 * Backfill managing-committee-member.address + electedRegion from:
 *  1) matched api::managing-committee.managing-committee rows (address / description)
 *  2) address / "Elected - …" lines already stored in notes
 *
 * Usage:
 *   node scripts/backfill-managing-committee-member-address-region.js --dry-run
 *   node scripts/backfill-managing-committee-member-address-region.js --tenant-id=mosc_malankara_orthodox_2 --term-year=2026
 *
 * npm: npm run backfill:managing-committee-members:address-region
 */

try {
  require('dotenv').config();
} catch (_) {}

const DRY_RUN =
  process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');
const REPLACE = process.argv.includes('--replace');

const UID = 'api::managing-committee-member.managing-committee-member';
const DIR_UID = 'api::managing-committee.managing-committee';

const TENANT_ID = (() => {
  const m = process.argv.find((a) => a.startsWith('--tenant-id='));
  if (m) return m.split('=').slice(1).join('=').trim();
  return process.env.TENANT_ID || 'mosc_malankara_orthodox_2';
})();

const TERM_YEAR = (() => {
  const m = process.argv.find((a) => a.startsWith('--term-year='));
  if (m) return parseInt(m.split('=')[1], 10) || 2026;
  return parseInt(process.env.TERM_YEAR || '2026', 10) || 2026;
})();

function asList(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  return result.results ?? result.data ?? [];
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(
      /\b(h\.?\s*h\.?|h\.?\s*g\.?|h\.?\s*b\.?|rev\.?\s*fr\.?|v\.?\s*rev\.?|sri\.?|adv\.?|dr\.?|fr\.?|mr\.?|mrs\.?|er\.?|prof\.?|metropolitan|cor\s+episcopa|corepiscopa)\b/gi,
      ' '
    )
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameTokens(norm) {
  return String(norm || '')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !['of', 'the', 'and', 'mar'].includes(t));
}

function isSamePerson(aNorm, bNorm) {
  if (!aNorm || !bNorm) return false;
  if (aNorm === bNorm) return true;
  const a = nameTokens(aNorm);
  const b = nameTokens(bNorm);
  if (!a.length || !b.length) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  const longSet = new Set(longer);
  if (!shorter.every((t) => longSet.has(t))) return false;
  const shortLast = shorter[shorter.length - 1];
  if (!longSet.has(shortLast)) return false;
  if (shorter.length < 2 && shortLast.length < 6) return false;
  return true;
}

/** Parse "Elected - NORTH EAST AMERICA - 2022-2027" / "Elected · KANDANAD EAST · 2022-2027" */
function parseElectedRegion(text) {
  const raw = String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[·•]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return null;

  const elected = raw.match(
    /^(elected|nominated)\s*[-–:]?\s*(.*?)(?:\s*[-–]\s*\d{4}\s*[-–/]\s*\d{2,4})?\s*$/i
  );
  if (elected) {
    const kind = elected[1].trim();
    let region = (elected[2] || '')
      .trim()
      .replace(/^[-–:\s]+/, '')
      .replace(/\s*[-–]\s*$/, '')
      .replace(/\s*[-–]\s*\d{4}\s*[-–/]\s*\d{2,4}\s*$/i, '')
      .trim();
    const kindLabel = kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase();
    if (!region || /^\d{4}\s*[-–/]\s*\d{2,4}$/.test(region)) return kindLabel;
    return region;
  }

  if (/^[A-Z][A-Z0-9 \-/&.]{2,80}$/.test(raw) && !/@/.test(raw)) return raw;
  return null;
}

function extractAddressFromNotes(notes) {
  if (!notes) return null;
  const lines = String(notes)
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const addressLines = [];
  for (const line of lines) {
    if (/^(mob|ph|tel|fax|cell|e-?mail|email|land\s*line|web|website|elected)\b/i.test(line)) break;
    if (/@/.test(line)) break;
    if (/^diocese of\b/i.test(line)) continue;
    if (/^parish\s*:/i.test(line)) continue;
    if (/^residence$/i.test(line)) continue;
    // Skip pure role / title leftovers
    if (/^(vice presidents?|president|priest trustee|lay trustee)$/i.test(line)) continue;
    addressLines.push(line);
  }
  const addr = addressLines.join('\n').trim();
  return addr.length >= 8 ? addr : null;
}

function extractElectedRegionFromNotes(notes) {
  if (!notes) return null;
  for (const line of String(notes).split(/\r?\n/)) {
    const region = parseElectedRegion(line.trim());
    if (region && /elected/i.test(line)) return region;
  }
  return null;
}

async function main() {
  console.log('Backfill MC member address + electedRegion');
  console.log('  Tenant:', TENANT_ID);
  console.log('  Term year:', TERM_YEAR);
  console.log('  Dry run:', DRY_RUN);
  console.log('  Replace existing:', REPLACE);
  console.log('');

  const prevNodeEnv = process.env.NODE_ENV;
  if (!process.env.STRAPI_IMPORT_NODE_ENV) process.env.NODE_ENV = 'staging';
  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const app = await createStrapi(await compileStrapi()).load();
  if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
  app.log.level = 'error';

  const tenantList = asList(
    await app.documents('api::tenant.tenant').findMany({ filters: { tenantId: TENANT_ID }, limit: 1 })
  );
  const tenant = tenantList[0];
  if (!tenant) {
    console.error('Tenant not found:', TENANT_ID);
    await app.destroy();
    process.exit(1);
  }

  const roster = asList(
    await app.documents(UID).findMany({
      filters: { termYear: TERM_YEAR },
      limit: 5000,
    })
  ).filter((r) => String(r.slug || '').endsWith('-mo2') || TENANT_ID !== 'mosc_malankara_orthodox_2');

  const directory = asList(
    await app.documents(DIR_UID).findMany({
      filters: {
        $or: [{ tenant: tenant.id }, { tenant: { documentId: tenant.documentId } }],
      },
      limit: 5000,
    })
  );

  console.log('Roster:', roster.length, '| Directory:', directory.length);

  const dirByNorm = new Map();
  for (const row of directory) {
    const n = normalizeName(row.name);
    if (n && !dirByNorm.has(n)) dirByNorm.set(n, row);
  }

  function findDirectoryMatch(rosterNorm) {
    if (dirByNorm.has(rosterNorm)) return dirByNorm.get(rosterNorm);
    for (const [n, row] of dirByNorm.entries()) {
      if (isSamePerson(rosterNorm, n)) return row;
    }
    return null;
  }

  let updated = 0;
  let skipped = 0;
  let fromDir = 0;
  let fromNotes = 0;

  for (const row of roster) {
    const patch = {};
    const dir = findDirectoryMatch(normalizeName(row.name));

    let address = row.address || null;
    let electedRegion = row.electedRegion || null;

    if ((!address || REPLACE) && dir?.address) {
      address = String(dir.address).trim();
      if (address) {
        patch.address = address;
        fromDir++;
      }
    }
    if ((!electedRegion || REPLACE) && dir?.description) {
      const region = parseElectedRegion(dir.description) || String(dir.description).trim();
      if (region) {
        electedRegion = region;
        patch.electedRegion = region;
        fromDir++;
      }
    }

    if ((!address || REPLACE) && !patch.address) {
      const fromNote = extractAddressFromNotes(row.notes);
      if (fromNote) {
        patch.address = fromNote;
        fromNotes++;
      }
    }
    if ((!electedRegion || REPLACE) && !patch.electedRegion) {
      const fromNote = extractElectedRegionFromNotes(row.notes);
      if (fromNote) {
        patch.electedRegion = fromNote;
        fromNotes++;
      }
    }

    // Also copy email/phones into notes only if notes empty? User didn't ask — skip.

    if (!Object.keys(patch).length) {
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(
        'Would update:',
        row.slug,
        '| address=',
        (patch.address || '-').slice(0, 60),
        '| region=',
        patch.electedRegion || '-'
      );
      updated++;
      continue;
    }

    await app.documents(UID).update({
      documentId: row.documentId,
      data: patch,
    });
    updated++;
    console.log('Updated:', row.slug, '| region=', patch.electedRegion || '(keep)', '| address=', patch.address ? 'yes' : '(keep)');
  }

  console.log('');
  console.log('--- Summary ---');
  console.log('  Updated:', updated);
  console.log('  Skipped (already filled / no source):', skipped);
  console.log('  Fields from directory matches:', fromDir);
  console.log('  Fields from notes parse:', fromNotes);

  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
