'use strict';

const { errors } = require('@strapi/utils');

/** Valid kebab-case slug after normalization (non-empty). */
const KEBAB_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const SLUG_FIELD_DESCRIPTION =
  'Lowercase kebab-case only (e.g. main-news). Use letters, numbers, and hyphens. ' +
  'Values are normalized when you save unless STRICT_KEBAB_SLUG=1 is set on the server.';

/**
 * Lowercase kebab-case slugs for Content API filters and frontend routes.
 * Matches scripts/rest_api_push_to_cloud.js normalizeSlug().
 */
function normalizeSlug(value) {
  if (value == null || typeof value !== 'string') return value;
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function isStrictKebabSlug() {
  const v = process.env.STRICT_KEBAB_SLUG;
  return v === '1' || v === 'true';
}

function isValidKebabSlug(value) {
  if (value == null || value === '') return true;
  return typeof value === 'string' && KEBAB_SLUG_REGEX.test(value);
}

/**
 * Normalize slug on save, or reject invalid slugs when STRICT_KEBAB_SLUG=1.
 * Strapi UID fields do not validate kebab-case while typing; this runs on save.
 */
function applyKebabSlugToEvent(event) {
  if (!event.params?.data || event.params.data.slug == null) return;
  const raw = event.params.data.slug;
  if (typeof raw !== 'string') return;

  const normalized = normalizeSlug(raw);
  if (!normalized) return;

  if (isStrictKebabSlug() && raw !== normalized) {
    throw new errors.ValidationError(
      'Slug must be lowercase kebab-case (e.g. main-news). Use only a-z, 0-9, and hyphens.',
      {
        errors: {
          slug: [
            `Invalid slug "${raw}". Use lowercase kebab-case like "${normalized}" instead.`,
          ],
        },
      }
    );
  }

  event.params.data.slug = normalized;
}

/** @deprecated Use applyKebabSlugToEvent */
function applyNormalizedSlugToEvent(event) {
  applyKebabSlugToEvent(event);
}

/** Content types with a top-level `slug` UID attribute (api:: only). */
const SLUG_CONTENT_TYPE_UIDS = [
  'api::article.article',
  'api::category.category',
  'api::tenant.tenant',
  'api::bishop.bishop',
  'api::catholicos.catholicos',
  'api::current-catholicos.current-catholicos',
  'api::diocesan-bishop.diocesan-bishop',
  'api::holy-synod-member.holy-synod-member',
  'api::ecumenical-article.ecumenical-article',
  'api::saint-entry.saint-entry',
  'api::catholicate-entry.catholicate-entry',
  'api::theological-seminary.theological-seminary',
  'api::training-program.training-program',
  'api::publication-entry.publication-entry',
  'api::retired-bishop.retired-bishop',
  'api::diocese.diocese',
  'api::parish.parish',
  'api::priest.priest',
  'api::directory-entry.directory-entry',
  'api::church-dignitary.church-dignitary',
  'api::working-committee.working-committee',
  'api::managing-committee.managing-committee',
  'api::spiritual-organisation.spiritual-organisation',
  'api::pilgrim-centre.pilgrim-centre',
  'api::institution.institution',
  'api::seminary.seminary',
  'api::kalpana-edition.kalpana-edition',
  'api::kalpana-document.kalpana-document',
];

function registerSlugNormalizeDocumentMiddleware(strapi) {
  strapi.documents.use(async (context, next) => {
    const { action, params, uid } = context;
    if (
      (action === 'create' || action === 'update') &&
      SLUG_CONTENT_TYPE_UIDS.includes(uid) &&
      params?.data &&
      params.data.slug != null &&
      typeof params.data.slug === 'string'
    ) {
      const raw = params.data.slug;
      const normalized = normalizeSlug(raw);
      if (normalized) {
        if (isStrictKebabSlug() && raw !== normalized) {
          throw new errors.ValidationError(
            'Slug must be lowercase kebab-case (e.g. main-news).',
            {
              errors: {
                slug: [
                  `Invalid slug "${raw}". Use lowercase kebab-case like "${normalized}".`,
                ],
              },
            }
          );
        }
        params.data.slug = normalized;
      }
    }
    return next();
  });
}

module.exports = {
  KEBAB_SLUG_REGEX,
  SLUG_FIELD_DESCRIPTION,
  normalizeSlug,
  isStrictKebabSlug,
  isValidKebabSlug,
  applyKebabSlugToEvent,
  applyNormalizedSlugToEvent,
  SLUG_CONTENT_TYPE_UIDS,
  registerSlugNormalizeDocumentMiddleware,
};
