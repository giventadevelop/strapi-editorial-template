'use strict';

/**
 * Scrape Managing Committee from https://mosc.in/administration/the-managing-committee/
 * and upsert into Directory – The Managing Committee (api::managing-committee.managing-committee).
 *
 * Clears existing rows, recreates from scrape, then links tenant via
 * managing_committees_tenant_lnk (lifecycle strips tenant on script creates).
 *
 *   node scripts/update-managing-committee-from-mosc-in.js
 *   node scripts/update-managing-committee-from-mosc-in.js --tenant-id=mosc_malankara_orthodox_2
 *   node scripts/update-managing-committee-from-mosc-in.js --dry-run
 */

try {
  require('dotenv').config();
} catch (_) {}

const cheerio = require('cheerio');

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');
const NO_PRUNE = process.argv.includes('--no-prune');
const SOURCE_URL = 'https://mosc.in/administration/the-managing-committee/';
const UID = 'api::managing-committee.managing-committee';

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

function effectiveSlug(baseSlug, tenantId) {
  if (tenantId === 'mosc_malankara_orthodox_2') return `${baseSlug}-mo2`;
  return baseSlug;
}

function cleanText(s) {
  return String(s || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractEmails(text) {
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return [...new Set(matches.map((e) => e.trim()))].join(', ') || null;
}

function extractPhones(text) {
  const phones = [];
  const labeled = [
    ...text.matchAll(/(?:Mob(?:ile)?|Ph(?:one)?|Tel)\s*[:.\-]?\s*([+0-9][0-9\s\-./,]{6,})/gi),
  ];
  for (const m of labeled) {
    const chunk = m[1]
      .split(/[,;/]+/)
      .map((p) => p.trim().replace(/\s+/g, ' '))
      .filter((p) => p.replace(/\D/g, '').length >= 7);
    phones.push(...chunk);
  }
  if (!phones.length) {
    const loose = text.match(/\+?\d[\d\s\-()]{8,}\d/g) || [];
    for (const p of loose) {
      if (p.replace(/\D/g, '').length >= 8) phones.push(p.trim());
    }
  }
  return [...new Set(phones)].join(', ') || null;
}

/**
 * Port of mosc-temp splitManagingCommitteeMemberText.
 */
function splitNameAddress(text) {
  const titleMatch = text.match(
    /^(Rev\.?\s*Fr\.?\s*(?:Dr\.?\s*)?|V\.\s*Rev\.?\s*|Adv\.?\s*|Sri\.?\s*|Dr\.?\s*|Er\.?\s*|Prof\.?\s*Dr\.?\s*)/i
  );
  const title = titleMatch?.[0] ?? '';
  const rest = text.slice(title.length).trimStart();
  if (!rest) return { name: text.trim(), address: '' };

  const words = rest.split(/\s+/);
  const stripTrailing = (w) => w.replace(/[.,]$/, '');

  const isInitial = (w) => {
    const c = stripTrailing(w);
    return /^[A-Z](?:\.[A-Z])+\.?$/i.test(c) || /^[A-Z]\.$/i.test(c);
  };

  const isAddressKeyword = (w) => {
    const c = stripTrailing(w);
    return /^(House|Veedu|Villa|Cottage|Bunglow|Bungalow|Bhavan|Bethel|Apartments?|Church|Hospital|Box|Sector|Road|Street|Layout|Enclave|Colony|Nagar|Homes|Post|Near|National|Mount|St\.?|Love|Green|Grace|Evergreen|Sony|Febin|Binil|Leela|Sreyas|Karunya|Ushasil|ANUGRAHA|Ebenezer|Dyudhi|Gandhi|Tuscany|Malankara)$/i.test(
      c
    );
  };

  const isPoOrContact = (w) => {
    const c = stripTrailing(w);
    return (
      /^(P\.O\.?,?|P\.O|PO)$/i.test(c) ||
      /^(Mob:?|Mob-|Ph:?|Ph\.|Mobile:?)$/i.test(c) ||
      /^No\.$/i.test(c) ||
      /^#\d/.test(c) ||
      /^R-\d/i.test(c) ||
      /^H\d/i.test(c) ||
      /@/.test(c)
    );
  };

  const looksLikeHouseName = (w) =>
    /(?:athu|ethil|ethu|eth|azhikathu|azhikom|kuttiyil|purathu|madom|thil|veedu|vilayil|kulam|kudi|parambil|moottil|plavayil|kalickal|kaleeckal)$/i.test(
      stripTrailing(w)
    );

  let i = 0;
  let personalWords = 0;
  while (i < words.length) {
    const w = words[i];
    const clean = stripTrailing(w);

    if (w === '(' || /^\(/.test(w)) {
      while (i < words.length && !words[i].includes(')')) i += 1;
      if (i < words.length) i += 1;
      continue;
    }

    if (i > 0 && (isAddressKeyword(clean) || isPoOrContact(clean))) break;

    if (personalWords >= 1 && i + 1 < words.length) {
      const next = stripTrailing(words[i + 1]);
      if (/^(House|Veedu|Villa|Cottage|Bunglow|Bungalow|Bhavan|Bethel|Apartments?)$/i.test(next)) {
        break;
      }
    }

    if (personalWords >= 2 && looksLikeHouseName(clean) && !isInitial(clean)) break;

    const endsComma = /,$/.test(w);
    i += 1;
    if (!isInitial(clean)) personalWords += 1;
    if (endsComma && personalWords >= 1) break;
    if (personalWords >= 3) break;
  }

  if (i === 0) i = Math.min(2, words.length);

  const name = `${title}${words.slice(0, i).join(' ')}`.replace(/,$/, '').trim();
  let address = words.slice(i).join(' ').replace(/^,\s*/, '').trim();
  address = address
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, ' ')
    .replace(/(?:Mob(?:ile)?|Ph(?:one)?|Tel)\s*[:.\-]?\s*[+0-9][0-9\s\-./,]{6,}/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[,\s]+$/g, '')
    .trim();

  return { name: name || text.slice(0, 80), address };
}

function scrapeManagingCommittee(html) {
  const $ = cheerio.load(html);
  const members = [];
  let section = 'elected';
  let diocese = '';
  let order = 0;
  let intro = '';

  // Intro: first substantial paragraph before PRESENT MEMBERS
  $('p').each((_, el) => {
    const t = cleanText($(el).text());
    if (/PRESENT MEMBERS/i.test(t)) return false;
    if (t.length > 80 && !intro) intro = t;
  });

  $('p, ul, ol').each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const $el = $(el);

    if (tag === 'p') {
      const t = cleanText($el.text());
      if (/\(ELECTED MEMBERS\)/i.test(t)) {
        section = 'elected';
        return;
      }
      if (/\(NOMINATED MEMBERS\)/i.test(t)) {
        section = 'nominated';
        diocese = 'Nominated Members';
        return;
      }
      return;
    }

    if (tag === 'ul') {
      const strong = cleanText($el.find('li strong').first().text() || $el.find('strong').first().text());
      if (strong && strong.length < 80 && !/PRESENT|ELECTED|NOMINATED|2022/i.test(strong)) {
        diocese = strong;
        if (section === 'nominated' && !/nominated/i.test(diocese)) {
          // keep nominated unless a diocese appears (shouldn't)
        }
      }
      return;
    }

    if (tag === 'ol') {
      $el.find('> li').each((__, li) => {
        const raw = cleanText($(li).text());
        if (!raw || raw.length < 10) return;
        if (/^(Kalpana|Downloads|Home|Sitemap)/i.test(raw)) return;
        const emails = extractEmails(raw);
        const phones = extractPhones(raw);
        const { name, address } = splitNameAddress(raw);
        const dioceseLabel = diocese || (section === 'nominated' ? 'Nominated Members' : 'Unknown');
        const description =
          section === 'nominated'
            ? 'Nominated · 2022-2027'
            : `Elected · ${dioceseLabel} · 2022-2027`;
        const memberOrder = order++;
        const baseSlug = `mc-${section === 'nominated' ? 'n' : 'e'}-${String(memberOrder).padStart(3, '0')}`;
        members.push({
          name,
          baseSlug,
          address: address || null,
          email: emails,
          phones,
          description,
          diocese: dioceseLabel,
          section,
          order: memberOrder,
          raw,
        });
      });
    }
  });

  // baseSlug already unique by order; keep as-is
  return { intro, members };
}

async function main() {
  console.log('Managing Committee update from mosc.in');
  console.log('  Source:', SOURCE_URL);
  console.log('  Tenants:', TENANT_IDS.join(', '));
  if (DRY_RUN) console.log('  DRY_RUN');
  if (NO_PRUNE) console.log('  --no-prune');

  const res = await fetch(SOURCE_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MOSC-Strapi-Import/1.0)' },
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status}`);
  const html = await res.text();
  const { intro, members } = scrapeManagingCommittee(html);
  console.log('  Intro chars:', intro.length);
  console.log('  Scraped members:', members.length);
  console.log(
    '  Elected:',
    members.filter((m) => m.section === 'elected').length,
    'Nominated:',
    members.filter((m) => m.section === 'nominated').length
  );
  console.log('  Sample:', members.slice(0, 3).map((m) => `${m.name} | ${m.diocese}`));
  console.log('  Tail:', members.slice(-2).map((m) => `${m.name} | ${m.diocese}`));

  if (members.length < 50) {
    console.error('Too few members scraped; aborting to avoid wiping data.');
    process.exit(1);
  }

  if (DRY_RUN) return;

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const app = await createStrapi(await compileStrapi()).load();
  app.log.level = 'error';

  let created = 0;
  let updated = 0;
  let deleted = 0;
  let skipped = 0;
  let tenantLinked = 0;

  async function ensureTenantLink(app, entityDocumentId, tenantNumericId) {
    if (!entityDocumentId || tenantNumericId == null) return false;
    const row = await app.db.query(UID).findOne({
      where: { documentId: entityDocumentId },
      select: ['id'],
    });
    if (!row?.id) return false;
    const knex = app.db.connection;
    const existing = await knex('managing_committees_tenant_lnk')
      .where({ managing_committee_id: row.id })
      .first();
    if (existing) {
      if (existing.tenant_id !== tenantNumericId) {
        await knex('managing_committees_tenant_lnk')
          .where({ managing_committee_id: row.id })
          .update({ tenant_id: tenantNumericId });
        return true;
      }
      return false;
    }
    await knex('managing_committees_tenant_lnk').insert({
      managing_committee_id: row.id,
      tenant_id: tenantNumericId,
    });
    return true;
  }

  try {
    // Clean slate: lifecycle strips tenant on script creates, leaving orphans.
    console.log('\nClearing existing managing-committee entries…');
    const existingAll = await app.documents(UID).findMany({ fields: ['slug'], limit: 5000 });
    const allRows = Array.isArray(existingAll) ? existingAll : existingAll?.results || [];
    for (const row of allRows) {
      try {
        await app.documents(UID).delete({ documentId: row.documentId });
        deleted++;
      } catch (e) {
        console.warn('Delete failed:', row.slug, e.message);
        skipped++;
      }
    }
    console.log('  Cleared:', deleted);

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
      const tenantNumericId = tenant.id;
      console.log(`\n=== Tenant ${tenantId} (id=${tenantNumericId}) ===`);

      for (const item of members) {
        const slug = effectiveSlug(item.baseSlug, tenantId);
        // Do not pass tenant in create payload — lifecycle deletes it without admin session.
        const payload = {
          name: item.name,
          slug,
          address: item.address,
          email: item.email,
          phones: item.phones,
          description: item.description,
          order: item.order,
        };

        try {
          const createdDoc = await app.documents(UID).create({ data: payload });
          const docId = createdDoc?.documentId ?? createdDoc?.document_id;
          created++;
          if (docId && (await ensureTenantLink(app, docId, tenantNumericId))) {
            tenantLinked++;
          }
          if (created <= 6 || created % 50 === 0) console.log('Created:', slug);
        } catch (e) {
          console.warn('Failed:', slug, e.message);
          skipped++;
        }
      }
    }
  } finally {
    await app.destroy();
  }

  console.log(
    '\nDone. Created:',
    created,
    'Updated:',
    updated,
    'Deleted:',
    deleted,
    'Tenant linked:',
    tenantLinked,
    'Skipped:',
    skipped
  );
  console.log('Admin: http://localhost:1337/admin/content-manager/collection-types/api::managing-committee.managing-committee');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
