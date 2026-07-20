'use strict';

/**
 * Scrape Seminaries from directory.mosc.in and update website (and other contact)
 * fields on Directory – Seminaries (api::seminary.seminary).
 *
 *   node scripts/update-seminaries-from-mosc-directory.js
 *   node scripts/update-seminaries-from-mosc-directory.js --tenant-id=tenant_demo_002
 *   DRY_RUN=1 node scripts/update-seminaries-from-mosc-directory.js
 */

try {
  require('dotenv').config();
} catch (_) {}

const https = require('https');
const cheerio = require('cheerio');

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const LIVE_URL = 'https://directory.mosc.in/directories/?type=seminaries';
const UID = 'api::seminary.seminary';

const TENANT_IDS = (() => {
  const m = process.argv.find((a) => a.startsWith('--tenant-id='));
  if (m) return [m.split('=')[1].trim()].filter(Boolean);
  return ['tenant_demo_002', 'mosc_malankara_orthodox_2'];
})();

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

function text($el) {
  return $el.text().trim().replace(/\s+/g, ' ');
}

function extractEmail($, $wrap) {
  const p = $wrap.find('p').filter((_, el) => $(el).find('.glyphicon-envelope').length);
  if (!p.length) return null;
  const hrefs = $(p[0])
    .find('a[href^="mailto:"]')
    .map((_, a) => $(a).attr('href').replace(/^mailto:/i, '').trim())
    .get()
    .filter(Boolean);
  if (hrefs.length) return hrefs.join(', ');
  const raw = text($(p[0]).clone().children().remove().end()).replace(/^:\s*/, '').trim();
  return raw || null;
}

function extractPhones($, $wrap) {
  const p = $wrap.find('p').filter((_, el) => $(el).find('.glyphicon-earphone').length);
  if (!p.length) return null;
  const links = $(p[0]).find('a[href^="tel:"]');
  const phones = links
    .map((_, a) => $(a).text().trim())
    .get()
    .filter(Boolean);
  if (phones.length) return phones.join(', ');
  const raw = text($(p[0]).clone().children().remove().end()).replace(/^:\s*/, '');
  return raw || null;
}

function extractAddress($, $wrap) {
  const paragraphs = $wrap.find('p');
  for (let i = 0; i < paragraphs.length; i++) {
    const p = $(paragraphs[i]);
    if (p.find('.glyphicon-envelope, .glyphicon-earphone, .glyphicon-globe').length) continue;
    const t = text(p);
    if (t && t.length > 3) return t;
  }
  return null;
}

/** Website from glyphicon-globe link, or bare www./http text in a globe paragraph. */
function extractWebsite($, $wrap) {
  const globeP = $wrap.find('p').filter((_, el) => $(el).find('.glyphicon-globe').length);
  if (globeP.length) {
    const a = $(globeP[0]).find('a').first();
    const href = a.attr('href');
    if (href && !/^mailto:/i.test(href) && !/^tel:/i.test(href)) {
      return normalizeWebsite(href);
    }
    const linkText = text(a);
    if (linkText) return normalizeWebsite(linkText);
    const raw = text($(globeP[0]).clone().children().remove().end()).replace(/^:\s*/, '').trim();
    if (raw) return normalizeWebsite(raw);
  }

  // Fallback: any external non-mailto/tel link that looks like a site
  const candidates = $wrap
    .find('a')
    .map((_, a) => {
      const href = $(a).attr('href') || '';
      const label = text($(a));
      return { href, label };
    })
    .get();

  for (const c of candidates) {
    if (/^mailto:|^tel:/i.test(c.href)) continue;
    if (/directory\.mosc\.in/i.test(c.href)) continue;
    if (/^https?:\/\//i.test(c.href) || /^www\./i.test(c.href) || /^www\./i.test(c.label)) {
      return normalizeWebsite(c.href || c.label);
    }
    if (/\.(edu|in|com|org|net)(\/|$)/i.test(c.label) || /\.(edu|in|com|org|net)(\/|$)/i.test(c.href)) {
      return normalizeWebsite(c.href || c.label);
    }
  }
  return null;
}

function normalizeWebsite(value) {
  if (!value) return null;
  let v = String(value).trim();
  if (!v) return null;
  if (/^mailto:|^tel:/i.test(v)) return null;
  if (/^\/\//.test(v)) v = `https:${v}`;
  if (!/^https?:\/\//i.test(v) && /^(www\.|[a-z0-9-]+\.[a-z]{2,})/i.test(v)) {
    v = `https://${v}`;
  }
  // Prefer https for storage
  v = v.replace(/^http:\/\//i, 'https://');
  return v;
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'StrapiSeminariesUpdate/1.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function scrapeSeminaries(html) {
  const $ = cheerio.load(html);
  const items = [];
  let order = 0;

  function pushEntry(art) {
    const wrap = art.find('.content-wrap').length ? art.find('.content-wrap') : art;
    const h3 = wrap.find('h3 a').first();
    const name = text(h3) || text(wrap.find('h3').first());
    if (!name) return;
    items.push({
      name,
      slug: slugify(name),
      address: extractAddress($, wrap) || null,
      email: extractEmail($, wrap) || null,
      phones: extractPhones($, wrap) || null,
      website: extractWebsite($, wrap) || null,
      order: order++,
    });
  }

  $('article.directories-item').each((_, article) => pushEntry($(article)));
  if (items.length === 0) {
    $('article').each((_, article) => pushEntry($(article)));
  }
  return items;
}

function effectiveSlug(baseSlug, tenantId) {
  if (tenantId === 'mosc_malankara_orthodox_2') return `${baseSlug}-mo2`;
  return baseSlug;
}

/** Match scraped slug to existing seminary even if slug suffixes differ (e.g. -nagpur-stots). */
function findExisting(list, item, tenantId) {
  const exact = effectiveSlug(item.slug, tenantId);
  let hit = list.find((e) => e.slug === exact);
  if (hit) return hit;

  const base = item.slug;
  hit = list.find((e) => {
    const s = e.slug.replace(/-mo2$/i, '');
    return s === base || s.startsWith(base) || base.startsWith(s);
  });
  if (hit) return hit;

  hit = list.find((e) => (e.name || '').toLowerCase() === item.name.toLowerCase());
  return hit || null;
}

async function main() {
  console.log('Seminaries update from directory.mosc.in');
  console.log('  Source:', LIVE_URL);
  console.log('  Tenants:', TENANT_IDS.join(', '));
  if (DRY_RUN) console.log('  DRY_RUN=1');

  const html = await fetchUrl(LIVE_URL);
  const scraped = scrapeSeminaries(html);
  console.log('  Scraped seminaries:', scraped.length);
  for (const item of scraped) {
    console.log(
      `   - [${item.order}] ${item.name} | website=${item.website || '-'} | email=${item.email || '-'}`
    );
  }

  if (scraped.length === 0) {
    console.error('No seminaries scraped; aborting.');
    process.exit(1);
  }

  if (DRY_RUN) process.exit(0);

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const app = await createStrapi(await compileStrapi()).load();
  app.log.level = 'error';

  let updated = 0;
  let created = 0;
  let skipped = 0;

  try {
    for (const tenantId of TENANT_IDS) {
      const tenant = await app.db.query('api::tenant.tenant').findOne({
        where: { tenantId },
        select: ['id', 'documentId', 'tenantId'],
      });
      if (!tenant) {
        console.warn('Tenant not found:', tenantId);
        skipped++;
        continue;
      }
      const tenantDocId = tenant.documentId ?? tenant.document_id ?? tenant.id;
      console.log(`\n=== Tenant ${tenantId} ===`);

      const existingList = await app.documents(UID).findMany({
        filters: {
          $or: [{ tenant: tenant.id }, { tenant: { documentId: tenantDocId } }],
        },
        limit: 50,
        populate: { tenant: true },
      });
      const list = existingList?.results ?? existingList?.data ?? (Array.isArray(existingList) ? existingList : []);

      for (const item of scraped) {
        const existing = findExisting(list, item, tenantId);
        const slug = existing?.slug || effectiveSlug(item.slug, tenantId);

        try {
          if (existing) {
            const docId = existing.documentId ?? existing.document_id;
            const patch = {};
            if (item.website) patch.website = item.website;
            if (item.address) patch.address = item.address;
            if (item.email) patch.email = item.email;
            if (item.phones) patch.phones = item.phones;
            if (typeof item.order === 'number') patch.order = item.order;

            if (Object.keys(patch).length === 0) {
              console.log('No changes:', slug);
              continue;
            }

            await app.documents(UID).update({ documentId: docId, data: patch });
            updated++;
            console.log('Updated:', slug, '→ website:', item.website || '(unchanged)');
          } else {
            await app.documents(UID).create({
              data: {
                name: item.name,
                slug,
                address: item.address,
                email: item.email,
                phones: item.phones,
                website: item.website,
                order: item.order,
                tenant: tenantDocId,
              },
            });
            created++;
            console.log('Created:', slug, '→ website:', item.website || '-');
          }
        } catch (e) {
          console.warn('Failed:', slug, e.message);
          skipped++;
        }
      }
    }
  } finally {
    await app.destroy();
  }

  console.log('\nDone. Created:', created, 'Updated:', updated, 'Skipped:', skipped);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
