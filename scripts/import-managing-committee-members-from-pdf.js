'use strict';

/**
 * Import Managing Committee members from the MOSC Managing-Committee-Members PDF.
 * Creates Directory – Managing Committee Members; does not modify managing-committee (directory contacts).
 *
 * Usage:
 *   node scripts/import-managing-committee-members-from-pdf.js --dry-run
 *   node scripts/import-managing-committee-members-from-pdf.js --tenant-id=mosc_malankara_orthodox_2 --term-year=2026
 *   node scripts/import-managing-committee-members-from-pdf.js --pdf=C:\\path\\to\\file.pdf --replace
 *
 * Default PDF URL: https://mosc.in/uploads/2026/04/Managing-Committee-Members.pdf
 * Photos: PDF portraits are not reliably extractable via text tools; rows are created without photo
 * unless --photo-dir points at named image files (slug.jpg / serial.jpg).
 */

try {
  require('dotenv').config();
} catch (_) {}

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const pdfParse = require('pdf-parse');
const mime = require('mime-types');

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');
const REPLACE = process.argv.includes('--replace');
const DEFAULT_PDF_URL = 'https://mosc.in/uploads/2026/04/Managing-Committee-Members.pdf';
const DEFAULT_LOCAL_PDF =
  'C:\\E_Drive\\code_backup\\mosc_downloads\\malankara-association-2026\\2026\\Managing-Committee-Members-1.pdf';
const UID = 'api::managing-committee-member.managing-committee-member';

const TENANT_ID = (() => {
  const m = process.argv.find((a) => a.startsWith('--tenant-id='));
  if (m) return m.split('=')[1].trim();
  return process.env.TENANT_ID || 'mosc_malankara_orthodox_2';
})();

const TERM_YEAR = (() => {
  const m = process.argv.find((a) => a.startsWith('--term-year='));
  if (m) return parseInt(m.split('=')[1], 10) || 2026;
  return parseInt(process.env.TERM_YEAR || '2026', 10) || 2026;
})();

const PDF_PATH_OR_URL = (() => {
  const m = process.argv.find((a) => a.startsWith('--pdf='));
  if (m) return m.split('=').slice(1).join('=').trim();
  if (process.env.MC_MEMBERS_PDF) return process.env.MC_MEMBERS_PDF;
  try {
    if (require('fs').existsSync(DEFAULT_LOCAL_PDF)) return DEFAULT_LOCAL_PDF;
  } catch (_) {}
  return DEFAULT_PDF_URL;
})();

const PHOTO_DIR = (() => {
  const m = process.argv.find((a) => a.startsWith('--photo-dir='));
  if (m) return m.split('=').slice(1).join('=').trim();
  return process.env.MC_MEMBERS_PHOTO_DIR || '';
})();

function slugify(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function effectiveSlug(baseSlug, tenantId, termYear, serial) {
  let slug = baseSlug || `member-${serial || 'x'}`;
  if (termYear) slug = `${slug}-${termYear}`;
  if (tenantId === 'mosc_malankara_orthodox_2' && !slug.endsWith('-mo2')) {
    slug = `${slug}-mo2`;
  }
  return slug;
}

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(
      url,
      {
        headers: { 'User-Agent': 'MOSC-ImportScript/1.0 (managing-committee-members)' },
        rejectUnauthorized: false,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          downloadBuffer(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on('error', reject);
  });
}

async function loadPdfBuffer(pdfPathOrUrl) {
  if (/^https?:\/\//i.test(pdfPathOrUrl)) {
    console.log('Downloading PDF:', pdfPathOrUrl);
    return downloadBuffer(pdfPathOrUrl);
  }
  const abs = path.resolve(pdfPathOrUrl);
  if (!fs.existsSync(abs)) throw new Error(`PDF not found: ${abs}`);
  return fs.readFileSync(abs);
}

function cleanPdfText(raw) {
  return String(raw || '')
    .replace(/\r/g, '\n')
    .replace(/PRELIMINARY LIST/gi, '\n')
    .replace(/THE MALANKARA ORTHODOX SYRIAN CHURCH/gi, '\n')
    .replace(/THE MALANKARA SYRIAN CHRISTIAN ASSOCIATION[\s\S]{0,80}?MANAGING COMMITTEE MEMBERS/gi, '\n')
    .replace(/MANAGING COMMITTEE MEMBERS\s*\(\s*ELECTED\s*\)\s*-?\s*2022-27/gi, '\n')
    .replace(/Sl\.?\s*No\.?\s*Name\s*&\s*Address\s*Remarks/gi, '\n')
    .replace(/See List of Bishops/gi, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function inferRoleFromNameLine(line, sectionRole) {
  const t = line.trim();
  if (/^PRESIDENT\b/i.test(t)) return 'President';
  if (/Vice\s*Presidents?/i.test(t) || sectionRole === 'Vice President') return 'Vice President';
  if (/\bPriest\s+Trustee\b/i.test(t)) return 'Priest Trustee';
  if (/\bLay\s+Trustee\b/i.test(t)) return 'Lay Trustee';
  if (/\bAssociation\s+Secretary\b/i.test(t)) return 'Association Secretary';
  if (/\bMetropolitan\b/i.test(t)) return 'Metropolitan';
  if (/^Rev\.?\s*Fr\./i.test(t) || /\bRev\.?\s*Fr\./i.test(t)) return 'Priest';
  if (/^V\.?\s*Rev\./i.test(t) || /\bCor\s+Episcopa\b/i.test(t)) return 'Priest';
  if (/^Adv\./i.test(t)) return 'Lay';
  if (/^Sri\./i.test(t) || /^Dr\./i.test(t)) return 'Lay';
  if (sectionRole) return sectionRole;
  return null;
}

function stripRolePrefixes(line) {
  return line
    .replace(/^(PRESIDENT|Vice\s*Presidents?|Priest\s+Trustee|Lay\s+Trustee|Association\s+Secretary)\s*/i, '')
    .replace(/^Metropolitan\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMembersFromText(text) {
  const cleaned = cleanPdfText(text);
  const idRe = /\b((?:M|WC|MC)-?\d+)\b/gi;
  const matches = [...cleaned.matchAll(idRe)];
  const members = [];
  let currentDiocese = null;
  let sectionRole = null;

  // Capture diocese section headers that appear before MC blocks
  const dioceseHeaderRe = /\n([A-Z][A-Z \-&.]{3,60})\n(?=(?:MC|M|WC)-?\d+)/g;
  const dioceseByOffset = [];
  let dm;
  while ((dm = dioceseHeaderRe.exec(cleaned)) !== null) {
    const label = dm[1].trim().replace(/\s+/g, ' ');
    if (/^(WORKING|NOMINATED|RESIDENCE|PRELIMINARY)/i.test(label)) continue;
    dioceseByOffset.push({ index: dm.index, label });
  }

  function dioceseAt(index) {
    let best = null;
    for (const d of dioceseByOffset) {
      if (d.index < index) best = d.label;
    }
    return best;
  }

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const serialToken = m[1].toUpperCase().replace(/^(M|WC|MC)-0+(\d)/, '$1-$2');
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : cleaned.length;
    let block = cleaned.slice(start, end).trim();
    if (!block) continue;

    // Detect role-only lines before name
    const lines = block
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .filter((l) => !/^\d+$/.test(l));

    if (!lines.length) continue;

    let roleHint = sectionRole;
    let nameLineIdx = 0;
    if (/^(PRESIDENT|Vice\s*Presidents?|Priest\s+Trustee|Lay\s+Trustee|Association\s+Secretary)$/i.test(lines[0])) {
      roleHint = inferRoleFromNameLine(lines[0], sectionRole);
      if (/Vice\s*Presidents?/i.test(lines[0])) sectionRole = 'Vice President';
      nameLineIdx = 1;
    }

    if (nameLineIdx >= lines.length) continue;
    const nameLine = lines[nameLineIdx];
    const role = inferRoleFromNameLine(nameLine, roleHint) || roleHint;
    let name = stripRolePrefixes(nameLine);
    name = name.replace(/\s+/g, ' ').trim();
    if (!name || name.length < 3) continue;
    if (/^(Diocese of|Mob:|Ph:|E-?mail:|Fax:|Residence)/i.test(name)) continue;

    let diocese = null;
    let parish = null;
    const noteLines = [];

    for (let li = nameLineIdx + 1; li < lines.length; li++) {
      const line = lines[li];
      const dioceseMatch = line.match(/^Diocese of\s+(.+)$/i);
      if (dioceseMatch) {
        diocese = dioceseMatch[1].trim().replace(/,\s*$/, '');
        continue;
      }
      if (/^Parish\s*:?\s*(.+)$/i.test(line)) {
        parish = line.replace(/^Parish\s*:?\s*/i, '').trim();
        continue;
      }
      if (/^(Mob|Ph|Tel|Fax|Cell|E-?mail|Land\s*line)\s*:/i.test(line) || /@/.test(line)) {
        noteLines.push(line);
        continue;
      }
      if (/^Residence$/i.test(line)) continue;
      noteLines.push(line);
    }

    if (!diocese && /^MC-/i.test(serialToken)) {
      diocese = dioceseAt(m.index) || currentDiocese;
    }
    if (diocese) currentDiocese = diocese;

    const serialNumber = parseInt(String(serialToken).replace(/^[A-Z]+-?/, ''), 10) || null;
    const notes = noteLines.join('\n').trim() || null;
    const baseSlug = slugify(name) || slugify(serialToken);

    members.push({
      serialToken,
      serialNumber,
      name,
      role,
      diocese,
      parish,
      notes,
      baseSlug,
      order: members.length + 1,
    });
  }

  return members;
}

async function getOrCreateTenant(strapi, tenantId) {
  const found = await strapi.documents('api::tenant.tenant').findMany({
    filters: { tenantId },
    limit: 1,
  });
  const list = found?.results ?? found?.data ?? (Array.isArray(found) ? found : []);
  if (list[0]) return list[0];
  console.log('Creating tenant:', tenantId);
  return strapi.documents('api::tenant.tenant').create({
    data: {
      tenantId,
      name: tenantId,
      slug: slugify(tenantId) || tenantId,
    },
  });
}

async function getUploadFileDocumentId(strapi, uploaded) {
  if (!uploaded) return null;
  if (uploaded.documentId) return uploaded.documentId;
  if (uploaded.id) {
    const row = await strapi.db.query('plugin::upload.file').findOne({
      where: { id: uploaded.id },
      select: ['documentId', 'document_id'],
    });
    return row?.documentId ?? row?.document_id ?? null;
  }
  return null;
}

async function uploadLocalImage(strapi, filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const stats = fs.statSync(filePath);
    const ext = path.extname(filePath).slice(1) || 'jpg';
    const mimetype = mime.lookup(ext) || 'image/jpeg';
    const name = path.basename(filePath, path.extname(filePath));
    const [uploaded] = await strapi.plugin('upload').service('upload').upload({
      data: { fileInfo: { name, alternativeText: name, caption: name } },
      files: {
        filepath: filePath,
        originalFileName: path.basename(filePath),
        size: stats.size,
        mimetype,
      },
    });
    const documentId = await getUploadFileDocumentId(strapi, uploaded);
    return documentId != null ? { documentId } : null;
  } catch (e) {
    console.warn('  Photo upload failed:', path.basename(filePath), e.message);
    return null;
  }
}

function resolvePhotoFile(member) {
  if (!PHOTO_DIR || !fs.existsSync(PHOTO_DIR)) return null;
  const candidates = [
    `${member.baseSlug}.jpg`,
    `${member.baseSlug}.jpeg`,
    `${member.baseSlug}.png`,
    `${member.baseSlug}.webp`,
    `${member.serialToken}.jpg`,
    `${String(member.serialToken).toLowerCase()}.jpg`,
  ];
  for (const name of candidates) {
    const p = path.join(PHOTO_DIR, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function main() {
  console.log('Tenant:', TENANT_ID);
  console.log('Term year:', TERM_YEAR);
  console.log('Dry run:', DRY_RUN);
  console.log('Replace:', REPLACE);
  console.log('PDF:', PDF_PATH_OR_URL);
  console.log('');

  const buf = await loadPdfBuffer(PDF_PATH_OR_URL);
  const parsed = await pdfParse(buf);
  const members = parseMembersFromText(parsed.text);
  console.log(`Parsed ${members.length} member(s) from PDF (${parsed.numpages} pages)`);
  if (!members.length) {
    console.error('No members parsed — aborting');
    process.exit(1);
  }

  if (DRY_RUN) {
    for (const m of members.slice(0, 15)) {
      console.log(
        `  [${m.serialToken}] ${m.name} | role=${m.role || '-'} | diocese=${m.diocese || '-'} | slug=${effectiveSlug(m.baseSlug, TENANT_ID, TERM_YEAR, m.serialNumber)}`
      );
    }
    if (members.length > 15) console.log(`  ... +${members.length - 15} more`);
    console.log('\nDry run complete — no Strapi writes.');
    return;
  }

  const prevNodeEnv = process.env.NODE_ENV;
  if (!process.env.STRAPI_IMPORT_NODE_ENV) {
    process.env.NODE_ENV = 'staging';
  }

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const app = await createStrapi(await compileStrapi()).load();
  if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
  app.log.level = 'error';

  const tenant = await getOrCreateTenant(app, TENANT_ID);
  const connectTenant = tenant.id;

  const existing = await app.documents(UID).findMany({
    filters: {
      $and: [
        { termYear: TERM_YEAR },
        { $or: [{ tenant: tenant.id }, { tenant: { documentId: tenant.documentId } }] },
      ],
    },
    limit: 2000,
  });
  const existingList = existing?.results ?? existing?.data ?? (Array.isArray(existing) ? existing : []);
  const bySlug = new Map();
  for (const row of existingList) {
    if (row.slug) bySlug.set(row.slug, row);
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const member of members) {
    const slug = effectiveSlug(member.baseSlug, TENANT_ID, TERM_YEAR, member.serialNumber);
    const prev = bySlug.get(slug);
    if (prev && !REPLACE) {
      skipped++;
      continue;
    }

    const data = {
      name: member.name,
      slug,
      role: member.role || null,
      diocese: member.diocese || null,
      parish: member.parish || null,
      serialNumber: member.serialNumber,
      order: member.order,
      isCurrent: true,
      termYear: TERM_YEAR,
      notes: member.notes,
      tenant: connectTenant,
    };

    let doc;
    if (prev && REPLACE) {
      doc = await app.documents(UID).update({ documentId: prev.documentId, data });
      updated++;
      console.log('Updated:', slug);
    } else {
      doc = await app.documents(UID).create({ data });
      created++;
      console.log('Created:', slug);
      bySlug.set(slug, doc);
    }

    // Document Service may ignore tenant connect — force link via db
    if (doc?.documentId && tenant?.id) {
      try {
        await app.db.query(UID).update({
          where: { documentId: doc.documentId },
          data: { tenant: tenant.id },
        });
      } catch (_) {}
    }

    const photoPath = resolvePhotoFile(member);
    if (photoPath && doc?.documentId) {
      const uploaded = await uploadLocalImage(app, photoPath);
      if (uploaded?.documentId) {
        try {
          await app.documents(UID).update({
            documentId: doc.documentId,
            data: { photo: { connect: [{ documentId: uploaded.documentId }] } },
          });
          console.log('  Photo:', path.basename(photoPath));
        } catch (e) {
          console.warn('  Photo connect failed:', e.message);
        }
      }
    }
  }

  console.log('');
  console.log(`Done. created=${created} updated=${updated} skipped=${skipped}`);
  await app.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
