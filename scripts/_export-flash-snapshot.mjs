import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
const get = (k) => {
  const m = env.match(new RegExp(`^${k}=(.*)$`, 'm'));
  return m ? m[1].trim() : '';
};
const base = (get('STRAPI_LOCAL_URL') || 'http://localhost:1337').replace(/\/$/, '');
const token = get('STRAPI_LOCAL_API_TOKEN');
const tenant = 'mosc_malankara_orthodox_2';
const headers = { Authorization: `Bearer ${token}` };
const url =
  `${base}/api/flash-news-items?` +
  `filters[tenant][tenantId][$eq]=${encodeURIComponent(tenant)}` +
  `&filters[publishedAt][$notNull]=true` +
  `&populate[0]=article&populate[1]=tenant` +
  `&sort=order:asc&pagination[pageSize]=20`;

const j = await fetch(url, { headers }).then((r) => r.json());
const out = {
  tenantId: tenant,
  exportedAt: new Date().toISOString(),
  source: 'local Strapi after flash-news article-link fix',
  count: (j.data || []).length,
  items: (j.data || []).map((i) => ({
    title: i.title,
    content: i.content,
    order: i.order,
    startDate: i.startDate,
    endDate: i.endDate,
    externalUrl: i.externalUrl,
    articleSlug: i.article?.slug || null,
    articleTitle: i.article?.title || null,
    articleDocumentId: i.article?.documentId || null,
    tenantId: i.tenant?.tenantId || null,
  })),
};
const dest = path.join(root, 'documentation', 'data', 'flash-news-article-links-local-snapshot.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 2));
console.log('wrote', dest, 'count', out.count);
console.log(JSON.stringify(out.items.map((i) => ({ title: i.title?.slice(0, 40), articleSlug: i.articleSlug })), null, 2));
