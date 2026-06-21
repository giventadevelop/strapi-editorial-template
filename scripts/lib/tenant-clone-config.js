'use strict';

/** Clone order: parents before children (PRD §4.4). */
const CLONE_ORDER = [
  'api::diocese.diocese',
  'api::parish.parish',
  'api::priest.priest',
  'api::bishop.bishop',
  'api::catholicos.catholicos',
  'api::diocesan-bishop.diocesan-bishop',
  'api::retired-bishop.retired-bishop',
  'api::directory-entry.directory-entry',
  'api::institution.institution',
  'api::church-dignitary.church-dignitary',
  'api::working-committee.working-committee',
  'api::managing-committee.managing-committee',
  'api::spiritual-organisation.spiritual-organisation',
  'api::pilgrim-centre.pilgrim-centre',
  'api::seminary.seminary',
  'api::holy-synod-member.holy-synod-member',
  'api::ecumenical-article.ecumenical-article',
  'api::saint-entry.saint-entry',
  'api::catholicate-entry.catholicate-entry',
  'api::theological-seminary.theological-seminary',
  'api::training-program.training-program',
  'api::publication-entry.publication-entry',
  'api::kalpana-edition.kalpana-edition',
  'api::kalpana-document.kalpana-document',
  'api::liturgy-day.liturgy-day',
  'api::flash-news-item.flash-news-item',
  'api::advertisement-slot.advertisement-slot',
  'api::article.article',
];

const SINGLE_TYPE_UIDS = new Set([
  'api::directory-home.directory-home',
  'api::kalpana-page.kalpana-page',
]);

/** Relation targets kept as-is (not remapped through clone id map). */
const GLOBAL_RELATION_TARGETS = new Set([
  'api::category.category',
  'api::author.author',
  'api::tenant.tenant',
  'plugin::upload.file',
]);

const SYSTEM_FIELDS = new Set([
  'id',
  'documentId',
  'document_id',
  'createdAt',
  'updatedAt',
  'createdBy',
  'updatedBy',
  'locale',
  'localizations',
  'publishedAt',
  'status',
]);

const MEDIA_FIELD_TYPES = new Set(['media']);

const PLURAL_BY_UID = {
  'api::diocese.diocese': 'dioceses',
  'api::parish.parish': 'parishes',
  'api::priest.priest': 'priests',
  'api::bishop.bishop': 'bishops',
  'api::article.article': 'articles',
  'api::liturgy-day.liturgy-day': 'liturgy-days',
  'api::kalpana-edition.kalpana-edition': 'kalpana-editions',
  'api::kalpana-document.kalpana-document': 'kalpana-documents',
  'api::institution.institution': 'institutions',
};

function pluralFromUid(uid) {
  if (PLURAL_BY_UID[uid]) return PLURAL_BY_UID[uid];
  const match = uid.match(/^api::([^.]+)\./);
  if (!match) return uid;
  const singular = match[1];
  if (singular.endsWith('y') && !singular.endsWith('ay') && !singular.endsWith('ey')) {
    return `${singular.slice(0, -1)}ies`;
  }
  if (singular.endsWith('s') || singular.endsWith('x') || singular.endsWith('ch') || singular.endsWith('sh')) {
    return `${singular}es`;
  }
  return `${singular}s`;
}

module.exports = {
  CLONE_ORDER,
  SINGLE_TYPE_UIDS,
  GLOBAL_RELATION_TARGETS,
  SYSTEM_FIELDS,
  MEDIA_FIELD_TYPES,
  pluralFromUid,
};
