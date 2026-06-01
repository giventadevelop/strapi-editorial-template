'use strict';

/** Lowercase kebab-case slugs for Content API filters (e.g. main-news, press-release). */
function normalizeCategorySlug(value) {
  if (value == null || typeof value !== 'string') return value;
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeSlugField(event) {
  if (!event.params?.data || event.params.data.slug == null) return;
  event.params.data.slug = normalizeCategorySlug(event.params.data.slug);
}

module.exports = {
  beforeCreate(event) {
    normalizeSlugField(event);
  },
  beforeUpdate(event) {
    normalizeSlugField(event);
  },
};
