'use strict';

/**
 * Registry for Cloud image migration (base64 upload via POST /api/migration/fix-published).
 * Used by push-collection-images-migration.js and finish-collection-images-on-cloud.js.
 *
 * Add a collection here when cloning push scripts for a new directory type.
 */
const COLLECTIONS = {
  catholicate: {
    label: 'Catholicate',
    uid: 'api::catholicate-entry.catholicate-entry',
    table: 'catholicate_entries',
    tenantLinkTable: 'catholicate_entries_tenant_lnk',
    entryIdCol: 'catholicate_entry_id',
    restPlural: 'catholicate-entries',
    mediaField: 'image',
    scoreImage: (name = '') => {
      if (/^Catholicos[-_]/i.test(name)) return 100;
      if (/MOSC_Logo/i.test(name)) return 90;
      return 0;
    },
    pushContentScript: 'push:catholicate-to-cloud',
    verifyScript: 'scripts/verify-catholicate-cloud.js',
    prd: 'catholicate-production-cloud-push-prd.html',
  },
  ecumenical: {
    label: 'Ecumenical',
    uid: 'api::ecumenical-article.ecumenical-article',
    table: 'ecumenical_articles',
    tenantLinkTable: 'ecumenical_articles_tenant_lnk',
    entryIdCol: 'ecumenical_article_id',
    restPlural: 'ecumenical-articles',
    mediaField: 'image',
    pushContentScript: 'push:ecumenical-to-cloud',
    prd: 'ecumenical-production-cloud-push-prd.html',
  },
  saints: {
    label: 'Saints',
    uid: 'api::saint-entry.saint-entry',
    table: 'saint_entries',
    tenantLinkTable: 'saint_entries_tenant_lnk',
    entryIdCol: 'saint_entry_id',
    restPlural: 'saint-entries',
    mediaField: 'image',
    pushContentScript: 'push:saints-to-cloud',
    prd: 'saints-production-cloud-push-prd.html',
  },
  publications: {
    label: 'Publications',
    uid: 'api::publication-entry.publication-entry',
    table: 'publication_entries',
    tenantLinkTable: 'publication_entries_tenant_lnk',
    entryIdCol: 'publication_entry_id',
    restPlural: 'publication-entries',
    mediaField: 'image',
    pushContentScript: 'push:publications-to-cloud',
    verifyScript: 'scripts/verify-publications-cloud.js',
    prd: 'publications-production-cloud-push-prd.html',
  },
  'theological-seminaries': {
    label: 'Theological Seminaries',
    uid: 'api::theological-seminary.theological-seminary',
    table: 'theological_seminaries',
    tenantLinkTable: 'theological_seminaries_tenant_lnk',
    entryIdCol: 'theological_seminary_id',
    restPlural: 'theological-seminaries',
    mediaField: 'image',
    pushContentScript: 'push:theological-seminaries-to-cloud',
    prd: 'theological-seminaries-production-cloud-push-prd.html',
  },
  'holy-synod': {
    label: 'Holy Synod',
    uid: 'api::holy-synod-member.holy-synod-member',
    table: 'holy_synod_members',
    tenantLinkTable: 'holy_synod_members_tenant_lnk',
    entryIdCol: 'holy_synod_member_id',
    restPlural: 'holy-synod-members',
    mediaField: 'image',
    pushContentScript: 'push:holy-synod-to-cloud',
    prd: 'holy-synod-production-cloud-push-prd.html',
  },
  institutions: {
    label: 'Institutions',
    uid: 'api::institution.institution',
    table: 'institutions',
    tenantLinkTable: 'institutions_tenant_lnk',
    entryIdCol: 'institution_id',
    restPlural: 'institutions',
    mediaField: 'image',
    pushContentScript: 'push:institutions-to-cloud',
    verifyScript: 'scripts/verify-institutions-cloud.js',
    prd: 'institutions-production-cloud-push-prd.html',
  },
  'kalpana-editions': {
    label: 'Kalpana Editions',
    uid: 'api::kalpana-edition.kalpana-edition',
    table: 'kalpana_editions',
    tenantLinkTable: 'kalpana_editions_tenant_lnk',
    entryIdCol: 'kalpana_edition_id',
    restPlural: 'kalpana-editions',
    mediaField: 'cardImage',
    pushContentScript: 'push:kalpana-editions-to-cloud',
  },
};

function getCollectionKey(argv = process.argv) {
  const arg = argv.find((a) => a.startsWith('--collection='));
  if (arg) return arg.split('=')[1];
  const idx = argv.indexOf('--collection');
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  return null;
}

function getCollectionConfig(key) {
  if (!key) return null;
  const normalized = String(key).toLowerCase();
  return COLLECTIONS[normalized] || null;
}

function listCollectionKeys() {
  return Object.keys(COLLECTIONS);
}

module.exports = {
  COLLECTIONS,
  getCollectionKey,
  getCollectionConfig,
  listCollectionKeys,
};
