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
    label: 'Saints & Blesseds',
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
  'current-catholicos': {
    label: 'Current Catholicos',
    uid: 'api::current-catholicos.current-catholicos',
    table: 'current_catholicos_entries',
    tenantLinkTable: 'current_catholicos_entries_tenant_lnk',
    entryIdCol: 'current_catholicos_id',
    restPlural: 'current-catholicos-entries',
    mediaField: 'image',
    scoreImage: (name = '') => {
      if (/Baselios.*Mathews/i.test(name)) return 100;
      if (/H\.?H/i.test(name)) return 90;
      return 0;
    },
    pushContentScript: 'push:current-catholicos-to-cloud',
    prd: 'current-catholicos-production-cloud-push-prd.html',
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
  dioceses: {
    label: 'Dioceses',
    uid: 'api::diocese.diocese',
    table: 'dioceses',
    tenantLinkTable: 'dioceses_tenant_lnk',
    entryIdCol: 'diocese_id',
    restPlural: 'dioceses',
    mediaField: 'image',
    pushContentScript: 'push:tenant-to-cloud',
  },
  'working-committees': {
    label: 'Working Committee',
    uid: 'api::working-committee.working-committee',
    table: 'working_committees',
    tenantLinkTable: 'working_committees_tenant_lnk',
    entryIdCol: 'working_committee_id',
    restPlural: 'working-committees',
    mediaField: 'image',
    pushContentScript: 'push:tenant-to-cloud',
  },
  'managing-committees': {
    label: 'Managing Committee',
    uid: 'api::managing-committee.managing-committee',
    table: 'managing_committees',
    tenantLinkTable: 'managing_committees_tenant_lnk',
    entryIdCol: 'managing_committee_id',
    restPlural: 'managing-committees',
    mediaField: 'image',
    pushContentScript: 'push:tenant-to-cloud',
  },
  'managing-committee-members': {
    label: 'Managing Committee Members',
    uid: 'api::managing-committee-member.managing-committee-member',
    table: 'managing_committee_members',
    tenantLinkTable: 'managing_committee_members_tenant_lnk',
    entryIdCol: 'managing_committee_member_id',
    restPlural: 'managing-committee-members',
    mediaField: 'photo',
    pushContentScript: 'push:managing-committee-members-to-cloud',
  },
  articles: {
    label: 'News Articles',
    uid: 'api::article.article',
    table: 'articles',
    tenantLinkTable: 'articles_tenant_lnk',
    entryIdCol: 'article_id',
    restPlural: 'articles',
    mediaField: 'cover',
    pushContentScript: 'push:tenant-to-cloud',
  },
  'advertisement-slots': {
    label: 'Advertisement Slots',
    uid: 'api::advertisement-slot.advertisement-slot',
    table: 'advertisement_slots',
    tenantLinkTable: 'advertisement_slots_tenant_lnk',
    entryIdCol: 'advertisement_slot_id',
    restPlural: 'advertisement-slots',
    mediaField: 'media',
    matchBy: 'documentId',
    pushContentScript: 'push:tenant-to-cloud',
  },
  training: {
    label: 'Training',
    uid: 'api::training-program.training-program',
    table: 'training_programs',
    tenantLinkTable: 'training_programs_tenant_lnk',
    entryIdCol: 'training_program_id',
    restPlural: 'training-programs',
    mediaField: 'image',
    pushContentScript: 'push:training-to-cloud',
    prd: 'training-production-cloud-push-prd.html',
  },
  'spiritual-organisations': {
    label: 'Spiritual Organisations',
    uid: 'api::spiritual-organisation.spiritual-organisation',
    table: 'spiritual_organisations',
    tenantLinkTable: 'spiritual_organisations_tenant_lnk',
    entryIdCol: 'spiritual_organisation_id',
    restPlural: 'spiritual-organisations',
    mediaField: 'image',
    pushContentScript: 'push:spiritual-organisations-to-cloud',
    prd: 'spiritual-organisations-production-cloud-push-prd.html',
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
  'kalpana-documents': {
    label: 'Kalpana Documents',
    uid: 'api::kalpana-document.kalpana-document',
    table: 'kalpana_documents',
    tenantLinkTable: 'kalpana_documents_tenant_lnk',
    entryIdCol: 'kalpana_document_id',
    restPlural: 'kalpana-documents',
    mediaField: 'pdf',
    pushContentScript: 'push:kalpana-documents-to-cloud',
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
