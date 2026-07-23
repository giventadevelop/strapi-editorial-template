'use strict';
/**
 * Scrape https://mosc.in/catholicate/catholicate/ and update local Strapi
 * catholicate-entry document (intro page).
 *
 * Usage:
 *   node scripts/update-catholicate-intro-from-mosc-in.js
 *   node scripts/update-catholicate-intro-from-mosc-in.js --document-id=bxudchfq321o6mhkjvx99l6f
 *   node scripts/update-catholicate-intro-from-mosc-in.js --dry-run
 */
try {
  require('dotenv').config();
} catch (_) {}

const SOURCE_URL = 'https://mosc.in/catholicate/catholicate/';
const STRAPI_URL = (process.env.STRAPI_URL || 'http://localhost:1337').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_API_TOKEN || process.env.API_TOKEN || '';
const DRY_RUN = process.argv.includes('--dry-run');

function getArg(name, fallback = null) {
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === `--${name}` && process.argv[i + 1]) return process.argv[i + 1].trim();
    const m = a.match(new RegExp(`^--${name}=(.+)$`));
    if (m) return m[1].trim();
  }
  return fallback;
}

const DOCUMENT_ID = getArg('document-id', 'bxudchfq321o6mhkjvx99l6f');

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function cleanText(s) {
  return decodeEntities(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Extract main article HTML blocks from mosc.in page markup.
 * Prefer the content column under .col-md-9 / article area; fall back to heading sections.
 */
function scrapeArticle(html) {
  let work = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Main column ends where the page-list sidebar begins
  const sidebarIdx = work.search(/<div class="col-md-3[\s\S]*?class="inner-links"|class="page-list/i);
  const titleIdx = work.search(/<h3[^>]*>\s*The Catholicate of the Malankara/i);
  if (titleIdx < 0) throw new Error('Could not find article title in page HTML');
  const end = sidebarIdx > titleIdx ? sidebarIdx : work.length;
  const slice = work.slice(titleIdx, end);

  const blocks = [];
  // Headings (h3/h4) and body paragraphs as <div align/style justify> or <p>
  const re =
    /<(h[234])(?:\s[^>]*)?>([\s\S]*?)<\/\1>|<div(?=[^>]*align="justify"|[^>]*text-align:\s*justify)[^>]*>([\s\S]*?)<\/div>|<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(slice)) !== null) {
    if (m[1]) {
      const text = cleanText(m[2]);
      if (!text) continue;
      if (/^the catholicate of the malankara/i.test(text)) {
        blocks.push({ tag: 'h2', text });
        continue;
      }
      // Section headings from source h4s
      blocks.push({ tag: 'h2', text });
      continue;
    }
    const rawInner = m[3] != null ? m[3] : m[4];
    const text = cleanText(rawInner);
    if (!text || text.length < 20) continue;
    // Skip empty / chrome
    if (/^(home|menu|toggle navigation)$/i.test(text)) continue;
    blocks.push({ tag: 'p', text });
  }

  if (!blocks.length) throw new Error('No content blocks scraped from page');

  const deduped = [];
  for (const b of blocks) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.tag === b.tag && prev.text === b.text) continue;
    deduped.push(b);
  }

  const bodyHtml = deduped
    .map((b) => {
      if (b.tag === 'p') return `<p>${escapeHtml(b.text)}</p>`;
      return `<${b.tag}>${escapeHtml(b.text)}</${b.tag}>`;
    })
    .join('\n');

  const titleBlock = deduped.find((b) => /^the catholicate of the malankara/i.test(b.text));
  const name = titleBlock
    ? titleBlock.text.replace(/\s+/g, ' ').trim()
    : 'The Catholicate of the Malankara Orthodox Syrian Church';

  let excerpt = '';
  const introIdx = deduped.findIndex((b) => /^introduction$/i.test(b.text));
  if (introIdx >= 0) {
    const nextP = deduped.slice(introIdx + 1).find((b) => b.tag === 'p');
    if (nextP) excerpt = nextP.text.slice(0, 280);
  }
  if (!excerpt) {
    const firstP = deduped.find((b) => b.tag === 'p');
    excerpt = (firstP?.text || '').slice(0, 280);
  }

  return { name, excerpt, bodyHtml, blockCount: deduped.length, blocks: deduped };
}

async function main() {
  console.log('Fetching', SOURCE_URL);
  const res = await fetch(SOURCE_URL, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; MOSC-Strapi-Import/1.0; +https://www.mosc-temp.com)',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status}`);
  const html = await res.text();
  const scraped = scrapeArticle(html);
  console.log('Scraped blocks:', scraped.blockCount);
  console.log('Name:', scraped.name);
  console.log('Excerpt:', scraped.excerpt.slice(0, 120) + '...');
  console.log('Body length:', scraped.bodyHtml.length);

  // Show section headings
  for (const b of scraped.blocks.filter((x) => x.tag !== 'p')) {
    console.log(' ', b.tag, b.text.slice(0, 80));
  }

  if (DRY_RUN) {
    console.log('DRY RUN — not writing to Strapi');
    console.log('--- body preview ---');
    console.log(scraped.bodyHtml.slice(0, 1500));
    return;
  }

  // Prefer REST when server is up; otherwise update via embedded Strapi Document Service.
  let usedEmbedded = false;
  let updatedBodyLen = scraped.bodyHtml.length;

  async function tryRestUpdate() {
    const headers = { 'Content-Type': 'application/json' };
    if (API_TOKEN) headers.Authorization = `Bearer ${API_TOKEN}`;
    const getRes = await fetch(`${STRAPI_URL}/api/catholicate-entries/${DOCUMENT_ID}?populate=*`, {
      headers,
    });
    if (!getRes.ok) throw new Error(`GET ${getRes.status}`);
    const current = (await getRes.json()).data;
    console.log('Current entry:', current.slug, 'bodyLen=', (current.body || '').length);
    const putRes = await fetch(`${STRAPI_URL}/api/catholicate-entries/${DOCUMENT_ID}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        data: {
          name: scraped.name,
          excerpt: scraped.excerpt,
          body: scraped.bodyHtml,
        },
      }),
    });
    const putText = await putRes.text();
    if (!putRes.ok) throw new Error(`PUT ${putRes.status}: ${putText.slice(0, 400)}`);
    const updated = JSON.parse(putText).data;
    updatedBodyLen = (updated.body || '').length;
    console.log('Updated via REST:', updated.documentId, 'bodyLen=', updatedBodyLen);
  }

  async function updateViaEmbeddedStrapi() {
    usedEmbedded = true;
    const { createStrapi, compileStrapi } = require('@strapi/strapi');
    const app = await createStrapi(await compileStrapi()).load();
    app.log.level = 'error';
    try {
      const existing = await app.documents('api::catholicate-entry.catholicate-entry').findOne({
        documentId: DOCUMENT_ID,
      });
      if (!existing) throw new Error(`Entry not found: ${DOCUMENT_ID}`);
      console.log('Current entry:', existing.slug, 'bodyLen=', (existing.body || '').length);
      const updated = await app.documents('api::catholicate-entry.catholicate-entry').update({
        documentId: DOCUMENT_ID,
        data: {
          name: scraped.name,
          excerpt: scraped.excerpt,
          body: scraped.bodyHtml,
        },
      });
      updatedBodyLen = (updated.body || '').length;
      console.log('Updated via Document Service:', updated.documentId, 'bodyLen=', updatedBodyLen);
    } finally {
      await app.destroy();
    }
  }

  try {
    await tryRestUpdate();
  } catch (err) {
    console.warn('REST unavailable (' + err.message + '); falling back to embedded Strapi…');
    await updateViaEmbeddedStrapi();
  }

  console.log('Done.', usedEmbedded ? '(embedded)' : '(REST)');
  console.log(
    'Admin:',
    `${STRAPI_URL}/admin/content-manager/collection-types/api::catholicate-entry.catholicate-entry/${DOCUMENT_ID}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
