'use strict';

/**
 * Scrape Kalpana PDF links from mosc.in, download PDFs, upload to Strapi Media Library,
 * and create Downloads – Kalpana Document entries linked to Kalpana Editions.
 *
 * Sources:
 *   - Live scrape: 2025, 2026 (https://mosc.in/downloads/kalpana/kalpana-{year}/)
 *   - Clone HTML: 2015–2024 (mosc-temp/code_clone_ref/mosc_in/downloads/kalpana/)
 *
 * Env / flags:
 *   TENANT_ID              (default: tenant_demo_002)
 *   MOSC_TEMP_DIR          (default: C:\project_workspace\mosc-temp)
 *   DRY_RUN=1              Preview manifest + counts, no download/import
 *   --manifest-only        Write manifest JSON only (no Strapi)
 *   --skip-download        Use cached PDFs in scripts/data/kalpana-pdfs/
 *   --skip-upload          Create DB rows with sourceUrl only (no PDF media)
 *   --replace              Delete existing tenant kalpana-documents before import
 *   --year=YYYY            Import a single year only
 *   --limit=N              Max documents per year
 *   --tenant-id=           Override tenant
 *
 *   npm run import:kalpana-documents -- --tenant-id=tenant_demo_002
 *   npm run import:kalpana-documents -- --manifest-only
 */

try {
  require('dotenv').config();
} catch (_) {}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cheerio = require('cheerio');
const mime = require('mime-types');
const { normalizeSlug } = require('../src/utils/normalize-slug');

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const MANIFEST_ONLY = process.argv.includes('--manifest-only');
const SKIP_DOWNLOAD = process.argv.includes('--skip-download');
const SKIP_UPLOAD = process.argv.includes('--skip-upload');
const REPLACE = process.argv.includes('--replace');

const TENANT_ID = (() => {
  const m = process.argv.find((a) => a.startsWith('--tenant-id='));
  if (m) return m.split('=')[1].trim();
  return process.env.TENANT_ID || 'tenant_demo_002';
})();

const YEAR_FILTER = (() => {
  const m = process.argv.find((a) => a.startsWith('--year='));
  return m ? m.split('=')[1].trim() : null;
})();

const LIMIT = (() => {
  const m = process.argv.find((a) => a.startsWith('--limit='));
  return m ? Math.max(1, parseInt(m.split('=')[1], 10)) : null;
})();

const MOSC_ROOT = path.resolve(
  process.env.MOSC_TEMP_DIR || process.env.STRAPI_DATA_IMPORT_MOSC_TEMP_DIR || 'C:\\project_workspace\\mosc-temp'
);
const CLONE_KALPANA_DIR = path.join(MOSC_ROOT, 'code_clone_ref', 'mosc_in', 'downloads', 'kalpana');
const PDF_CACHE_DIR = path.join(__dirname, 'data', 'kalpana-pdfs');
const MANIFEST_PATH = path.join(__dirname, '..', 'documentation', 'kalpana', 'kalpana-documents-manifest.json');

const LIVE_SCRAPE_YEARS = new Set(['2025', '2026']);
const ALL_YEARS = ['2026', '2025', '2024', '2023', '2022', '2021', '2020', '2019', '2018', '2017', '2016', '2015'];

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const EDITION_UID = 'api::kalpana-edition.kalpana-edition';
const DOC_UID = 'api::kalpana-document.kalpana-document';

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolvePdfUrl(href, baseUrl) {
  if (!href) return null;
  let u = href.trim();
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u.split('#')[0];
  try {
    return new URL(u, baseUrl).href.split('#')[0];
  } catch (_) {
    return null;
  }
}

function parseKalpanaNumber(title) {
  const t = title || '';
  const patterns = [
    /Kalpana\s*No\.?\s*(\d+[A-Za-z]?)/i,
    /No\.?\s*(\d+[A-Za-z]?)\s/i,
    /No\.?\s*(\d+[A-Za-z]?)$/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return m[1];
  }
  return null;
}

function buildDocumentSlug(title, pdfUrl, usedSlugs) {
  const fileBase = path.basename(pdfUrl, '.pdf');
  const fromTitle = normalizeSlug(title);
  const fromFile = normalizeSlug(fileBase);
  const hash = crypto.createHash('md5').update(pdfUrl).digest('hex').slice(0, 8);
  let base = fromTitle && fromTitle.length > 4 ? fromTitle : fromFile;
  if (!base || base.length < 3) base = 'kalpana-document';
  if (base.length > 72) base = base.slice(0, 72).replace(/-+$/, '');

  let slug = `${base}-${hash}`;
  let n = 2;
  while (usedSlugs.has(slug)) {
    slug = `${base}-${hash}-${n}`;
    n++;
  }
  usedSlugs.add(slug);
  return slug;
}

function getLiveYearPageUrl(year) {
  if (year === '2015') return 'https://mosc.in/downloads/kalpana/kalpana/';
  return `https://mosc.in/downloads/kalpana/kalpana-${year}/`;
}

function getCloneHtmlPath(year) {
  if (!fs.existsSync(CLONE_KALPANA_DIR)) return null;
  if (year === '2015') {
    const p = path.join(CLONE_KALPANA_DIR, 'kalpana', 'index.html');
    return fs.existsSync(p) ? p : null;
  }
  const flat = path.join(CLONE_KALPANA_DIR, `kalpana-${year}.html`);
  if (fs.existsSync(flat)) return flat;
  const nested = path.join(CLONE_KALPANA_DIR, `kalpana-${year}`, 'index.html');
  if (fs.existsSync(nested)) return nested;
  return null;
}

function parsePdfLinksFromHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  const byUrl = new Map();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || !/\.pdf(\?|#|$)/i.test(href)) return;
    const pdfUrl = resolvePdfUrl(href, pageUrl);
    if (!pdfUrl) return;

    let title = decodeHtmlEntities($(el).text());
    if (!title || title.length < 4) {
      title = decodeHtmlEntities($(el).closest('p').text());
    }
    if (!title) {
      title = decodeHtmlEntities(path.basename(pdfUrl, '.pdf').replace(/[-_]+/g, ' '));
    }

    const existing = byUrl.get(pdfUrl);
    if (!existing || title.length > existing.title.length) {
      byUrl.set(pdfUrl, { title, pdfUrl });
    }
  });

  return Array.from(byUrl.values());
}

async function fetchLiveHtml(year) {
  const pageUrl = getLiveYearPageUrl(year);
  const res = await fetch(pageUrl, {
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`Live fetch ${pageUrl} → HTTP ${res.status}`);
  }
  const html = await res.text();
  return { html, pageUrl, source: 'live' };
}

function loadCloneHtml(year) {
  const filePath = getCloneHtmlPath(year);
  if (!filePath) return null;
  const html = fs.readFileSync(filePath, 'utf8');
  const pageUrl = getLiveYearPageUrl(year);
  return { html, pageUrl, source: 'clone', filePath };
}

async function collectYearDocuments(year) {
  let payload;
  if (LIVE_SCRAPE_YEARS.has(year)) {
    try {
      payload = await fetchLiveHtml(year);
    } catch (err) {
      console.warn(`  Live scrape failed for ${year}:`, err.message, '— falling back to clone HTML');
      payload = loadCloneHtml(year);
    }
  } else {
    payload = loadCloneHtml(year);
  }

  if (!payload) {
    console.warn(`  No HTML source for year ${year}`);
    return { year, source: 'missing', pageUrl: getLiveYearPageUrl(year), documents: [] };
  }

  const rawDocs = parsePdfLinksFromHtml(payload.html, payload.pageUrl);
  const usedSlugs = new Set();
  const documents = rawDocs.map((doc, index) => {
    const title = doc.title || `Kalpana document ${index + 1}`;
    const slug = buildDocumentSlug(title, doc.pdfUrl, usedSlugs);
    return {
      title,
      slug,
      pdfUrl: doc.pdfUrl,
      kalpanaNumber: parseKalpanaNumber(title),
      order: rawDocs.length - index,
    };
  });

  return {
    year,
    source: payload.source,
    pageUrl: payload.pageUrl,
    clonePath: payload.filePath || null,
    documents,
  };
}

function cachePathForPdf(pdfUrl, year) {
  const hash = crypto.createHash('md5').update(pdfUrl).digest('hex').slice(0, 10);
  const base = path.basename(pdfUrl).split('?')[0] || 'document.pdf';
  const safe = base.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return path.join(PDF_CACHE_DIR, year, `${hash}-${safe}`);
}

async function downloadPdf(pdfUrl, destPath, referer) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const res = await fetch(pdfUrl, {
    headers: {
      'User-Agent': BROWSER_UA,
      Referer: referer,
      Accept: 'application/pdf,*/*',
    },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100 || buf.slice(0, 4).toString() !== '%PDF') {
    throw new Error('Response is not a valid PDF');
  }
  fs.writeFileSync(destPath, buf);
  return destPath;
}

async function buildManifest(years) {
  const manifest = {
    generatedAt: new Date().toISOString(),
    tenantId: TENANT_ID,
    years: {},
    totals: { years: 0, documents: 0 },
  };

  for (const year of years) {
    console.log(`Collecting ${year}...`);
    const yearData = await collectYearDocuments(year);
    let docs = yearData.documents;
    if (LIMIT) docs = docs.slice(0, LIMIT);
    manifest.years[year] = {
      source: yearData.source,
      pageUrl: yearData.pageUrl,
      clonePath: yearData.clonePath,
      documentCount: docs.length,
      documents: docs,
    };
    manifest.totals.years += 1;
    manifest.totals.documents += docs.length;
    console.log(`  ${year}: ${docs.length} PDFs (${yearData.source})`);
  }

  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
  console.log('');
  console.log('Manifest written:', MANIFEST_PATH);
  console.log('Total documents:', manifest.totals.documents);
  return manifest;
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

async function uploadPdfFile(strapi, filePath, title) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const stats = fs.statSync(filePath);
    const ext = path.extname(filePath).slice(1) || 'pdf';
    const mimetype = mime.lookup(ext) || 'application/pdf';
    const name = path.basename(filePath, path.extname(filePath));
    const [uploaded] = await strapi.plugin('upload').service('upload').upload({
      data: {
        fileInfo: {
          name: name.slice(0, 100),
          alternativeText: title.slice(0, 200),
          caption: title.slice(0, 200),
        },
      },
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
    console.warn('  PDF upload failed:', path.basename(filePath), e.message);
    return null;
  }
}

async function setMediaRelationViaDb(strapi, entityDocumentId, fileDocumentId, fieldName = 'pdf') {
  try {
    const entityRow = await strapi.db.query(DOC_UID).findOne({
      where: { documentId: entityDocumentId },
      select: ['id'],
    });
    const fileRow = await strapi.db.query('plugin::upload.file').findOne({
      where: { documentId: fileDocumentId },
      select: ['id'],
    });
    if (!entityRow?.id || !fileRow?.id) return false;
    const db = strapi.db.connection;
    const morphTable = 'files_related_mph';
    await db(morphTable)
      .where({ related_id: entityRow.id, related_type: DOC_UID, field: fieldName })
      .del();
    await db(morphTable).insert({
      file_id: fileRow.id,
      related_id: entityRow.id,
      related_type: DOC_UID,
      field: fieldName,
      order: 1,
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function linkPdf(strapi, entityDocumentId, uploaded) {
  if (!uploaded?.documentId || !entityDocumentId) return;
  try {
    await strapi.documents(DOC_UID).update({
      documentId: entityDocumentId,
      data: { pdf: { connect: [{ documentId: uploaded.documentId }] } },
    });
  } catch (_) {}
  await setMediaRelationViaDb(strapi, entityDocumentId, uploaded.documentId, 'pdf');
}

async function getOrCreateTenant(strapi, tenantId) {
  const existing = await strapi.db.query('api::tenant.tenant').findOne({
    where: { tenantId },
    select: ['id', 'documentId', 'document_id'],
  });
  if (existing) {
    return { id: existing.id, documentId: existing.documentId ?? existing.document_id ?? existing.id };
  }
  const created = await strapi.documents('api::tenant.tenant').create({
    data: {
      name: 'MOSC Demo',
      tenantId,
      slug: tenantId,
      domain: 'mosc.in',
      description: 'Malankara Orthodox Syrian Church',
    },
  });
  return { id: created.id, documentId: created.documentId ?? created.document_id ?? created.id };
}

async function findEditionByYear(strapi, tenant, year) {
  const slug = normalizeSlug(`kalpana-${year}`);
  const result = await strapi.documents(EDITION_UID).findMany({
    filters: { slug, tenant: tenant.id },
    limit: 1,
  });
  const list = result?.results ?? result?.data ?? (Array.isArray(result) ? result : []);
  return list[0] || null;
}

async function findDocumentBySourceUrl(strapi, tenant, sourceUrl) {
  const result = await strapi.documents(DOC_UID).findMany({
    filters: { sourceUrl, tenant: tenant.id },
    limit: 1,
  });
  const list = result?.results ?? result?.data ?? (Array.isArray(result) ? result : []);
  return list[0] || null;
}

async function deleteTenantDocuments(strapi, tenant) {
  const existing = await strapi.documents(DOC_UID).findMany({
    filters: { tenant: tenant.id },
    limit: 10000,
  });
  const list = existing?.results ?? existing?.data ?? (Array.isArray(existing) ? existing : []);
  let deleted = 0;
  for (const row of list) {
    const docId = row.documentId ?? row.document_id;
    if (!docId) continue;
    try {
      await strapi.documents(DOC_UID).delete({ documentId: docId });
      deleted++;
    } catch (e) {
      console.warn('  Delete failed:', docId, e.message);
    }
  }
  return deleted;
}

async function importManifestToStrapi(manifest) {
  const prevNodeEnv = process.env.NODE_ENV;
  if (!process.env.STRAPI_IMPORT_NODE_ENV) {
    process.env.NODE_ENV = 'staging';
  }

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  const tenant = await getOrCreateTenant(app, TENANT_ID);
  console.log('Tenant:', TENANT_ID, '(id', tenant.id + ')');

  if (REPLACE) {
    const deleted = await deleteTenantDocuments(app, tenant);
    console.log('Deleted existing kalpana documents:', deleted);
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let downloaded = 0;
  let uploadFailures = 0;

  const years = Object.keys(manifest.years).sort((a, b) => Number(b) - Number(a));

  for (const year of years) {
    const yearBlock = manifest.years[year];
    const edition = await findEditionByYear(app, tenant, year);
    if (!edition?.id) {
      console.warn(`  No kalpana edition for ${year} — run npm run import:kalpana first. Skipping year.`);
      skipped += yearBlock.documents.length;
      continue;
    }

    console.log(`Importing ${year} (${yearBlock.documents.length} documents)...`);

    for (const doc of yearBlock.documents) {
      const referer = yearBlock.pageUrl;
      const localPath = cachePathForPdf(doc.pdfUrl, year);

      if (!SKIP_DOWNLOAD && !SKIP_UPLOAD) {
        if (!fs.existsSync(localPath)) {
          try {
            await downloadPdf(doc.pdfUrl, localPath, referer);
            downloaded++;
          } catch (e) {
            console.warn('  Download failed:', doc.title.slice(0, 60), '—', e.message);
            uploadFailures++;
          }
        }
      }

      const data = {
        title: doc.title,
        slug: doc.slug,
        sourceUrl: doc.pdfUrl,
        kalpanaNumber: doc.kalpanaNumber,
        order: doc.order,
        edition: edition.id,
        tenant: tenant.id,
      };

      try {
        const existing = await findDocumentBySourceUrl(app, tenant, doc.pdfUrl);
        let row;
        if (existing?.documentId) {
          row = await app.documents(DOC_UID).update({
            documentId: existing.documentId,
            data,
          });
          updated++;
        } else {
          row = await app.documents(DOC_UID).create({ data });
          created++;
          try {
            await app.db.query(DOC_UID).update({
              where: { documentId: row.documentId },
              data: { tenant: tenant.id },
            });
          } catch (_) {}
        }

        if (!SKIP_UPLOAD && fs.existsSync(localPath) && row?.documentId) {
          const uploaded = await uploadPdfFile(app, localPath, doc.title);
          if (uploaded?.documentId) {
            await linkPdf(app, row.documentId, uploaded);
          } else {
            uploadFailures++;
          }
        }
      } catch (e) {
        console.warn('  Import failed:', doc.slug, e.message);
        skipped++;
      }
    }
  }

  console.log('');
  console.log('Import summary');
  console.log('  Created:', created);
  console.log('  Updated:', updated);
  console.log('  Skipped:', skipped);
  console.log('  PDFs downloaded:', downloaded);
  console.log('  Upload/download failures:', uploadFailures);

  await app.destroy();
  if (!process.env.STRAPI_IMPORT_NODE_ENV) {
    process.env.NODE_ENV = prevNodeEnv;
  }
}

let app;

async function main() {
  console.log('Kalpana documents import from mosc.in');
  console.log('  MOSC_ROOT:', MOSC_ROOT);
  console.log('  TENANT_ID:', TENANT_ID);
  console.log('  PDF cache:', PDF_CACHE_DIR);
  if (DRY_RUN) console.log('  DRY_RUN=1');
  if (MANIFEST_ONLY) console.log('  --manifest-only');
  if (SKIP_DOWNLOAD) console.log('  --skip-download');
  if (SKIP_UPLOAD) console.log('  --skip-upload');
  if (REPLACE) console.log('  --replace');
  if (YEAR_FILTER) console.log('  --year=', YEAR_FILTER);
  if (LIMIT) console.log('  --limit=', LIMIT);
  console.log('');

  const years = YEAR_FILTER ? [YEAR_FILTER] : ALL_YEARS;
  const manifest = await buildManifest(years);

  if (DRY_RUN || MANIFEST_ONLY) {
    process.exit(0);
  }

  await importManifestToStrapi(manifest);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  if (app) app.destroy().catch(() => {});
  process.exit(1);
});
