'use strict';

/**
 * Sync Directory – Managing Committee Members roster:
 *  1) Upsert members from Association PDF (default: Managing-Committee-Members-1.pdf)
 *  2) Merge missing contacts from api::managing-committee.managing-committee (no duplicates)
 *  3) Optionally extract embedded PDF portrait JPEGs for members still missing photo
 *     (low-res; never overwrites an existing photo unless --replace-photos)
 *
 * Does NOT modify managing-committee directory rows.
 *
 * Usage:
 *   node scripts/sync-managing-committee-roster.js --dry-run
 *   node scripts/sync-managing-committee-roster.js --tenant-id=mosc_malankara_orthodox_2 --term-year=2026
 *   node scripts/sync-managing-committee-roster.js --extract-pdf-photos
 *   node scripts/sync-managing-committee-roster.js --skip-directory-merge
 *
 * npm: npm run sync:managing-committee-roster
 */

try {
  require('dotenv').config();
} catch (_) {}

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mime = require('mime-types');

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');
const REPLACE = process.argv.includes('--replace');
const REPLACE_PHOTOS = process.argv.includes('--replace-photos');
const EXTRACT_PDF_PHOTOS = process.argv.includes('--extract-pdf-photos');
const SKIP_DIRECTORY_MERGE = process.argv.includes('--skip-directory-merge');
const SKIP_PDF = process.argv.includes('--skip-pdf');

const UID = 'api::managing-committee-member.managing-committee-member';
const DIR_UID = 'api::managing-committee.managing-committee';

const DEFAULT_PDF =
  'C:\\E_Drive\\code_backup\\mosc_downloads\\malankara-association-2026\\2026\\Managing-Committee-Members-1.pdf';
const FALLBACK_PDF =
  'C:\\E_Drive\\code_backup\\mosc_downloads\\malankara-association-2026\\2026\\Managing-Committee-Members.pdf';

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

const PDF_PATH = (() => {
  const m = process.argv.find((a) => a.startsWith('--pdf='));
  if (m) return m.split('=').slice(1).join('=').trim();
  if (process.env.MC_MEMBERS_PDF) return process.env.MC_MEMBERS_PDF;
  if (fs.existsSync(DEFAULT_PDF)) return DEFAULT_PDF;
  if (fs.existsSync(FALLBACK_PDF)) return FALLBACK_PDF;
  return DEFAULT_PDF;
})();

const PHOTO_OUT = path.join(process.cwd(), 'tmp', 'mc-pdf-photos');

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

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(
      /\b(h\.?\s*h\.?|h\.?\s*g\.?|h\.?\s*b\.?|rev\.?\s*fr\.?|v\.?\s*rev\.?|sri\.?|adv\.?|dr\.?|fr\.?|mr\.?|mrs\.?|metropolitan|cor\s+episcopa|corepiscopa)\b/gi,
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

/**
 * True when directory contact is the same person as an existing roster row
 * (directory often appends house / place names the PDF omits).
 */
function isSamePerson(dirNorm, rosterNorm) {
  if (!dirNorm || !rosterNorm) return false;
  if (dirNorm === rosterNorm) return true;
  const a = nameTokens(dirNorm);
  const b = nameTokens(rosterNorm);
  if (!a.length || !b.length) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  const longSet = new Set(longer);
  const contained = shorter.every((t) => longSet.has(t));
  if (!contained) return false;
  // Require last token of the shorter name to appear in the longer (family/house anchor)
  const shortLast = shorter[shorter.length - 1];
  if (!longSet.has(shortLast)) return false;
  // Avoid ultra-short collisions (e.g. only "jacob")
  if (shorter.length < 2 && shortLast.length < 6) return false;
  return true;
}

function findRosterMatch(dirNorm, byNorm) {
  if (byNorm.has(dirNorm)) return byNorm.get(dirNorm);
  for (const [rosterNorm, row] of byNorm.entries()) {
    if (isSamePerson(dirNorm, rosterNorm)) return row;
  }
  return null;
}

function asList(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  return result.results ?? result.data ?? [];
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

function parseMembersFromText(text) {
  const cleaned = cleanPdfText(text);
  const idRe = /\b((?:M|WC|MC)-?\d+)\b/gi;
  const matches = [...cleaned.matchAll(idRe)];
  const members = [];
  let currentDiocese = null;
  let sectionRole = null;

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
    const block = cleaned.slice(start, end).trim();
    if (!block) continue;

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
    let name = stripRolePrefixes(nameLine).replace(/\s+/g, ' ').trim();
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
    members.push({
      source: 'pdf',
      serialToken,
      serialNumber,
      name,
      role,
      diocese,
      parish,
      notes: noteLines.join('\n').trim() || null,
      baseSlug: slugify(name) || slugify(serialToken),
      order: members.length + 1,
      norm: normalizeName(name),
    });
  }
  return members;
}

function extractJpegBuffers(pdfBuf) {
  const images = [];
  let i = 0;
  while (i < pdfBuf.length - 1) {
    if (pdfBuf[i] === 0xff && pdfBuf[i + 1] === 0xd8) {
      let j = i + 2;
      while (j < pdfBuf.length - 1) {
        if (pdfBuf[j] === 0xff && pdfBuf[j + 1] === 0xd9) {
          images.push(pdfBuf.subarray(i, j + 2));
          i = j + 2;
          break;
        }
        j++;
      }
      if (j >= pdfBuf.length - 1) break;
    } else i++;
  }
  return images;
}

function jpegDims(buf) {
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const len = (buf[i + 2] << 8) + buf[i + 3];
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { width: (buf[i + 7] << 8) + buf[i + 8], height: (buf[i + 5] << 8) + buf[i + 6] };
    }
    i += 2 + len;
  }
  return { width: 0, height: 0 };
}

async function isLikelySealOrLogo(jpegBuf) {
  // Known seal size in this PDF + sharp red-dominant check when available
  const d = jpegDims(jpegBuf);
  if (d.width === 175 && d.height === 177) return true;
  try {
    const sharp = require('sharp');
    const { data, info } = await sharp(jpegBuf).resize(24, 24, { fit: 'fill' }).raw().toBuffer({
      resolveWithObject: true,
    });
    let r = 0;
    let g = 0;
    let b = 0;
    const n = info.width * info.height;
    for (let i = 0; i < data.length; i += 3) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
    r /= n;
    g /= n;
    b /= n;
    // Red seal on white: high R relative, or very pink cast
    if (r > 200 && g > 170 && b > 170 && r > g && r > b) return true;
    if (r > 140 && r > g * 1.35 && r > b * 1.35) return true;
  } catch (_) {}
  return false;
}

async function extractPortraitFiles(pdfBuf, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const jpegs = extractJpegBuffers(pdfBuf);
  const kept = [];
  for (const im of jpegs) {
    const d = jpegDims(im);
    const sizeOk =
      im.length >= 2500 &&
      im.length <= 30000 &&
      d.width >= 70 &&
      d.width <= 220 &&
      d.height >= 70 &&
      d.height <= 250;
    if (!sizeOk) continue;
    if (await isLikelySealOrLogo(im)) continue;
    kept.push({ buf: im, ...d, bytes: im.length });
  }
  const files = [];
  for (let i = 0; i < kept.length; i++) {
    const name = `photo-${String(i + 1).padStart(3, '0')}.jpg`;
    const filePath = path.join(outDir, name);
    fs.writeFileSync(filePath, kept[i].buf);
    files.push(filePath);
  }
  fs.writeFileSync(
    path.join(outDir, 'manifest.json'),
    JSON.stringify(
      kept.map((k, i) => ({
        index: i + 1,
        width: k.width,
        height: k.height,
        bytes: k.bytes,
        file: path.basename(files[i]),
      })),
      null,
      2
    )
  );
  return files;
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

async function setPhotoViaDb(strapi, entityDocumentId, fileDocumentId) {
  try {
    const entityRow = await strapi.db.query(UID).findOne({
      where: { documentId: entityDocumentId },
      select: ['id'],
    });
    const fileRow = await strapi.db.query('plugin::upload.file').findOne({
      where: { documentId: fileDocumentId },
      select: ['id'],
    });
    if (!entityRow?.id || !fileRow?.id) return false;
    const db = strapi.db.connection;
    await db('files_related_mph')
      .where({ related_id: entityRow.id, related_type: UID, field: 'photo' })
      .del();
    await db('files_related_mph').insert({
      file_id: fileRow.id,
      related_id: entityRow.id,
      related_type: UID,
      field: 'photo',
      order: 1,
    });
    return true;
  } catch (e) {
    console.warn('  DB photo link failed:', e.message);
    return false;
  }
}

async function attachPhoto(strapi, docId, fileDocumentId) {
  try {
    await strapi.documents(UID).update({
      documentId: docId,
      data: { photo: { connect: [{ documentId: fileDocumentId }] } },
    });
  } catch (_) {}
  return setPhotoViaDb(strapi, docId, fileDocumentId);
}

function inferRoleFromDirectoryName(name) {
  return inferRoleFromNameLine(name, null) || 'Lay';
}

function directoryNotes(row) {
  const parts = [];
  if (row.phones) parts.push(`Ph: ${String(row.phones).trim()}`);
  if (row.email) parts.push(`Email: ${String(row.email).trim()}`);
  if (row.website) parts.push(`Web: ${String(row.website).trim()}`);
  // address + elected region go to dedicated fields; keep description remnant if not elected
  if (row.description && !/^elected\b/i.test(String(row.description).trim())) {
    parts.push(String(row.description).trim());
  }
  return parts.filter(Boolean).join('\n') || null;
}

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
  return null;
}

async function main() {
  console.log('Sync Managing Committee roster');
  console.log('  Tenant:', TENANT_ID);
  console.log('  Term year:', TERM_YEAR);
  console.log('  PDF:', PDF_PATH);
  console.log('  Dry run:', DRY_RUN);
  console.log('  Merge directory:', !SKIP_DIRECTORY_MERGE);
  console.log('  Extract PDF photos:', EXTRACT_PDF_PHOTOS);
  console.log('');

  let pdfMembers = [];
  let pdfBuf = null;
  if (!SKIP_PDF) {
    if (!fs.existsSync(PDF_PATH)) throw new Error('PDF not found: ' + PDF_PATH);
    pdfBuf = fs.readFileSync(PDF_PATH);
    const parsed = await pdfParse(pdfBuf);
    pdfMembers = parseMembersFromText(parsed.text);
    console.log(`PDF parsed: ${pdfMembers.length} member(s) (${parsed.numpages} pages)`);

    // Also absorb any extra unique serials from the alternate PDF if present
    if (fs.existsSync(FALLBACK_PDF) && path.resolve(FALLBACK_PDF) !== path.resolve(PDF_PATH)) {
      const alt = await pdfParse(fs.readFileSync(FALLBACK_PDF));
      const altMembers = parseMembersFromText(alt.text);
      const have = new Set(pdfMembers.map((m) => m.norm));
      let added = 0;
      for (const m of altMembers) {
        if (m.norm && !have.has(m.norm)) {
          m.order = pdfMembers.length + 1;
          pdfMembers.push(m);
          have.add(m.norm);
          added++;
        }
      }
      if (added) console.log(`  +${added} extra unique name(s) from Managing-Committee-Members.pdf`);
    }
  }

  const prevNodeEnv = process.env.NODE_ENV;
  if (!process.env.STRAPI_IMPORT_NODE_ENV) process.env.NODE_ENV = 'staging';
  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const app = await createStrapi(await compileStrapi()).load();
  if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
  app.log.level = 'error';

  const tenantFound = await app.documents('api::tenant.tenant').findMany({
    filters: { tenantId: TENANT_ID },
    limit: 1,
  });
  const tenant = asList(tenantFound)[0];
  if (!tenant) {
    console.error('Tenant not found:', TENANT_ID);
    await app.destroy();
    process.exit(1);
  }

  const existingResult = await app.documents(UID).findMany({
    filters: { termYear: TERM_YEAR },
    populate: { photo: true, tenant: true },
    limit: 5000,
  });
  let existing = asList(existingResult).filter((r) => {
    if (String(r.slug || '').endsWith('-mo2') && TENANT_ID === 'mosc_malankara_orthodox_2') return true;
    const tid = r.tenant?.tenantId ?? r.tenant?.tenant_id;
    return tid === TENANT_ID || !r.tenant;
  });

  const bySlug = new Map(existing.map((r) => [r.slug, r]));
  const byNorm = new Map();
  for (const r of existing) {
    const n = normalizeName(r.name);
    if (n && !byNorm.has(n)) byNorm.set(n, r);
  }

  const stats = {
    pdfCreated: 0,
    pdfUpdated: 0,
    pdfSkipped: 0,
    dirCreated: 0,
    dirSkipped: 0,
    photosLinked: 0,
    photosSkipped: 0,
  };

  // --- PDF upsert ---
  for (const member of pdfMembers) {
    const slug = effectiveSlug(member.baseSlug, TENANT_ID, TERM_YEAR, member.serialNumber);
    const prev = bySlug.get(slug) || byNorm.get(member.norm);
    if (prev && !REPLACE) {
      stats.pdfSkipped++;
      continue;
    }
    const data = {
      name: member.name,
      slug: prev?.slug || slug,
      role: member.role || null,
      diocese: member.diocese || null,
      parish: member.parish || null,
      serialNumber: member.serialNumber,
      order: member.order,
      isCurrent: true,
      termYear: TERM_YEAR,
      notes: member.notes,
      tenant: tenant.id,
    };
    if (DRY_RUN) {
      console.log(prev ? 'Would update PDF:' : 'Would create PDF:', data.slug, '|', data.name);
      if (prev) stats.pdfUpdated++;
      else stats.pdfCreated++;
      continue;
    }
    let doc;
    if (prev) {
      doc = await app.documents(UID).update({ documentId: prev.documentId, data });
      stats.pdfUpdated++;
      console.log('Updated PDF:', data.slug);
    } else {
      doc = await app.documents(UID).create({ data });
      stats.pdfCreated++;
      console.log('Created PDF:', data.slug);
    }
    try {
      await app.db.query(UID).update({
        where: { documentId: doc.documentId },
        data: { tenant: tenant.id },
      });
    } catch (_) {}
    bySlug.set(data.slug, doc);
    byNorm.set(member.norm, doc);
  }

  // --- Directory merge (missing only) ---
  if (!SKIP_DIRECTORY_MERGE) {
    const dirResult = await app.documents(DIR_UID).findMany({
      filters: {
        $or: [{ tenant: tenant.id }, { tenant: { documentId: tenant.documentId } }],
      },
      populate: { image: true },
      limit: 5000,
    });
    const dirList = asList(dirResult);
    console.log(`Directory contacts: ${dirList.length}`);

    let nextOrder = Math.max(0, ...[...bySlug.values()].map((r) => r.order || 0)) + 1;

    for (const row of dirList) {
      const n = normalizeName(row.name);
      if (!n) continue;
      const existingMatch = findRosterMatch(n, byNorm);
      if (existingMatch) {
        // Enrich address / electedRegion / notes on existing PDF row from directory
        if (!DRY_RUN && existingMatch.documentId) {
          const patch = {};
          if (row.address && !existingMatch.address) patch.address = String(row.address).trim();
          const region = parseElectedRegion(row.description) || (row.description ? String(row.description).trim() : null);
          if (region && !existingMatch.electedRegion) patch.electedRegion = region;
          const notes = directoryNotes(row);
          if (notes && (!existingMatch.notes || existingMatch.notes.length < 20)) {
            patch.notes = existingMatch.notes ? `${existingMatch.notes}\n${notes}` : notes;
          }
          if (Object.keys(patch).length) {
            try {
              await app.documents(UID).update({
                documentId: existingMatch.documentId,
                data: patch,
              });
            } catch (_) {}
          }
        }
        stats.dirSkipped++;
        continue;
      }
      const baseSlug = slugify(row.name) || `dir-${row.id || nextOrder}`;
      const slug = effectiveSlug(baseSlug, TENANT_ID, TERM_YEAR, nextOrder);
      if (bySlug.has(slug)) {
        stats.dirSkipped++;
        continue;
      }
      const data = {
        name: row.name,
        slug,
        role: inferRoleFromDirectoryName(row.name),
        diocese: null,
        parish: null,
        address: row.address ? String(row.address).trim() : null,
        electedRegion: parseElectedRegion(row.description) || (row.description ? String(row.description).trim() : null),
        serialNumber: null,
        order: nextOrder++,
        isCurrent: true,
        termYear: TERM_YEAR,
        notes: directoryNotes(row),
        tenant: tenant.id,
      };
      if (DRY_RUN) {
        console.log('Would create from directory:', slug, '|', row.name);
        stats.dirCreated++;
        byNorm.set(n, { slug });
        continue;
      }
      const doc = await app.documents(UID).create({ data });
      try {
        await app.db.query(UID).update({
          where: { documentId: doc.documentId },
          data: { tenant: tenant.id },
        });
      } catch (_) {}
      // Prefer connecting existing directory image if present
      const imgDocId = row.image?.documentId || row.image?.document_id;
      if (imgDocId) {
        await attachPhoto(app, doc.documentId, imgDocId);
        stats.photosLinked++;
      }
      stats.dirCreated++;
      console.log('Created from directory:', slug);
      bySlug.set(slug, doc);
      byNorm.set(n, doc);
    }
  }

  // --- PDF embedded photos (only fill empty) ---
  if (EXTRACT_PDF_PHOTOS && pdfBuf) {
    console.log('Extracting PDF portrait JPEGs…');
    const files = await extractPortraitFiles(pdfBuf, PHOTO_OUT);
    console.log(`  Portrait files: ${files.length} → ${PHOTO_OUT}`);

    // Reload roster ordered by PDF order / order field
    const rosterResult = await app.documents(UID).findMany({
      filters: { termYear: TERM_YEAR },
      populate: { photo: true },
      limit: 5000,
      sort: 'order:asc',
    });
    const roster = asList(rosterResult).filter((r) => String(r.slug || '').endsWith('-mo2'));

    // Prefer mapping to PDF-sourced members by order index
    const pdfOrdered = roster.filter((r) => r.serialNumber != null).sort((a, b) => (a.order || 0) - (b.order || 0));
    const targets = pdfOrdered.length ? pdfOrdered : roster;

    for (let i = 0; i < targets.length && i < files.length; i++) {
      const row = targets[i];
      const hasPhoto = Boolean(row.photo?.documentId || row.photo?.url);
      if (hasPhoto && !REPLACE_PHOTOS) {
        stats.photosSkipped++;
        continue;
      }
      if (DRY_RUN) {
        console.log('Would attach PDF photo:', row.slug, '←', path.basename(files[i]));
        stats.photosLinked++;
        continue;
      }
      const uploaded = await uploadLocalImage(app, files[i]);
      if (uploaded?.documentId) {
        const ok = await attachPhoto(app, row.documentId, uploaded.documentId);
        if (ok) {
          stats.photosLinked++;
          console.log('PDF photo:', row.slug, '←', path.basename(files[i]));
        }
      }
    }
  }

  const final = await app.documents(UID).findMany({
    filters: { termYear: TERM_YEAR },
    populate: { photo: true },
    limit: 5000,
  });
  const finalList = asList(final).filter((r) => String(r.slug || '').endsWith('-mo2'));
  const withPhoto = finalList.filter((r) => r.photo?.documentId || r.photo?.url).length;

  console.log('');
  console.log('--- Summary ---');
  console.log('  PDF created/updated/skipped:', stats.pdfCreated, stats.pdfUpdated, stats.pdfSkipped);
  console.log('  Directory created/skipped:', stats.dirCreated, stats.dirSkipped);
  console.log('  Photos linked/skipped-existing:', stats.photosLinked, stats.photosSkipped);
  console.log('  Roster now:', finalList.length, '| with photo:', withPhoto);

  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
