import React from 'react';

const ARTICLE_UID = 'api::article.article';

/**
 * Format datetime for display (locale-friendly).
 */
function formatPublishedAt(value) {
  if (value == null || value === '') return '—';
  try {
    const d = typeof value === 'string' ? new Date(value) : value;
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return '—';
  }
}

/**
 * Side panel component: show "Published at" for Article edit view only.
 * Used by addEditViewSidePanel so the date is visible next to draft/published.
 */
function PublishedAtPanel(props) {
  const { model, document, activeTab } = props || {};
  if (model !== ARTICLE_UID) {
    return { title: 'Published at', content: null };
  }
  const publishedAt = document?.publishedAt;
  const content =
    publishedAt != null
      ? formatPublishedAt(publishedAt)
      : activeTab === 'published'
        ? '—'
        : 'Draft (not published yet)';
  return {
    title: 'Published at',
    content: React.createElement('div', { style: { marginTop: 4 } }, content),
  };
}

export default {
  config: {
    locales: [],
  },

  bootstrap(app) {
    // ----- List view: add "Published at" column for Article -----
    // Note: payload does not include "model"; derive from URL (e.g. .../collection-types/api::article.article)
    const listViewHook = 'Admin/CM/pages/ListView/inject-column-in-table';
    app.registerHook(listViewHook, (payload) => {
      if (!payload) return payload;
      const path = typeof window !== 'undefined' && window.location?.pathname ? window.location.pathname : '';
      const model = path.match(/\/collection-types\/([^/]+)(?:\/|$)/)?.[1] || payload.model;
      if (model !== ARTICLE_UID) return payload;
      const { displayedHeaders = [], layout } = payload;
      const arr = Array.isArray(displayedHeaders) ? displayedHeaders : [];
      const hasAlready = arr.some((h) => h?.name === 'publishedAt');
      if (hasAlready) return payload;

      const publishedAtColumn = {
        name: 'publishedAt',
        label: { id: 'app.components.ListView.publishedAt', defaultMessage: 'Published at' },
        sortable: true,
        searchable: false,
        mainField: undefined,
        attribute: { type: 'datetime' },
        cellFormatter(data, _header, _ctx) {
          const value = data?.publishedAt;
          return value != null ? formatPublishedAt(value) : '—';
        },
      };

      const listLayout = layout?.layout || [];
      const nextLayout = layout
        ? { ...layout, layout: [...listLayout, publishedAtColumn] }
        : { layout: [publishedAtColumn] };

      return {
        ...payload,
        displayedHeaders: [...arr, publishedAtColumn],
        layout: nextLayout,
      };
    });

    // ----- Edit view: add "Published at" panel in sidebar (draft/published area) -----
    const plugin = app.getPlugin('content-manager');
    if (plugin?.apis?.addEditViewSidePanel) {
      plugin.apis.addEditViewSidePanel((panels) => [PublishedAtPanel, ...(panels || [])]);
    }
  },
};
