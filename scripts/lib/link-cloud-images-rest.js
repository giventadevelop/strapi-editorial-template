'use strict';

/**
 * Link uploaded Cloud media to entries via REST PUT (fallback when migration morph link is unavailable).
 */

async function cloudFetch(CLOUD_URL, API_TOKEN, pathname, options = {}) {
  const url = pathname.startsWith('http') ? pathname : `${CLOUD_URL}${pathname}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_TOKEN}`,
      ...options.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function getCloudEntriesBySlug(CLOUD_URL, API_TOKEN, restPlural) {
  const map = new Map();
  let page = 1;
  while (true) {
    const data = await cloudFetch(
      CLOUD_URL,
      API_TOKEN,
      `/api/${restPlural}?pagination[page]=${page}&pagination[pageSize]=100&fields[0]=slug`
    );
    const list = data?.data ?? [];
    if (list.length === 0) break;
    for (const row of list) {
      const slug = row.slug;
      const documentId = row.documentId ?? row.document_id ?? row.id;
      if (slug && documentId) map.set(slug, documentId);
    }
    if (list.length < 100) break;
    page++;
  }
  return map;
}

async function findCloudFileByHash(CLOUD_URL, API_TOKEN, hash) {
  const data = await cloudFetch(
    CLOUD_URL,
    API_TOKEN,
    `/api/upload/files?filters[hash][$eq]=${encodeURIComponent(hash)}&pagination[pageSize]=1`
  );
  const files = Array.isArray(data) ? data : data?.data ?? [];
  return files[0] ?? null;
}

/**
 * @param {object} opts
 * @param {string} opts.cloudUrl
 * @param {string} opts.apiToken
 * @param {string} opts.restPlural
 * @param {Array<{slug:string, hash:string}>} opts.links
 */
async function linkImagesViaRest({ cloudUrl, apiToken, restPlural, links, mediaField = 'image' }) {
  const bySlug = await getCloudEntriesBySlug(cloudUrl, apiToken, restPlural);
  const results = { linked: 0, skipped: 0, errors: [] };

  for (const { slug, hash } of links) {
    if (!slug || !hash) {
      results.skipped++;
      continue;
    }
    try {
      const documentId = bySlug.get(slug);
      if (!documentId) throw new Error('Cloud entry not found.');
      const file = await findCloudFileByHash(cloudUrl, apiToken, hash);
      if (!file?.id) throw new Error(`Cloud file not found for hash ${hash}.`);
      await cloudFetch(cloudUrl, apiToken, `/api/${restPlural}/${documentId}`, {
        method: 'PUT',
        body: JSON.stringify({ data: { [mediaField]: file.id } }),
      });
      results.linked++;
    } catch (err) {
      results.errors.push({ slug, error: err.message });
    }
  }
  return results;
}

module.exports = { linkImagesViaRest, getCloudEntriesBySlug, findCloudFileByHash };
