'use strict';

/**
 * Export articles and categories for tenant tenant_demo_002 to a JSON file.
 * Use before deleting articles to keep a backup for testing.
 *
 * Run from project root: node scripts/export_news_tenant_demo.js
 * Config: TENANT_ID (default tenant_demo_002), EXPORT_OUTPUT_PATH (default exports/news_tenant_demo_002_YYYYMMDD.json)
 */

try {
  require('dotenv').config();
} catch (_) {}

const path = require('path');
const fs = require('fs');

const TENANT_ID = process.env.TENANT_ID || 'tenant_demo_002';
const EXPORT_OUTPUT_PATH =
  process.env.EXPORT_OUTPUT_PATH ||
  path.join(
    process.cwd(),
    'exports',
    `news_${TENANT_ID}_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`
  );

function serializeForExport(article) {
  const a = {
    title: article.title,
    description: article.description,
    slug: article.slug,
    publishedAt: article.publishedAt,
    views: article.views ?? 0,
    isFeatured: article.isFeatured ?? false,
  };
  if (article.category) {
    a.categorySlug = article.category.slug ?? article.category.slug;
  }
  if (article.cover) {
    a.cover = {
      url: article.cover.url,
      alternativeText: article.cover.alternativeText,
      name: article.cover.name,
    };
  }
  if (article.author) {
    a.authorName = article.author.name;
    a.authorEmail = article.author.email;
  }
  return a;
}

async function main() {
  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  try {
    const tenant = await app.db.query('api::tenant.tenant').findOne({
      where: { tenantId: TENANT_ID },
      select: ['id', 'documentId'],
    });

    if (!tenant) {
      console.error('Tenant not found:', TENANT_ID);
      process.exit(1);
    }

    const articles = await app.db.query('api::article.article').findMany({
      where: {
        tenant: { id: tenant.id },
      },
      populate: {
        category: { select: ['id', 'name', 'slug', 'description'] },
        cover: { select: ['url', 'alternativeText', 'name'] },
        author: { select: ['name', 'email'] },
      },
    });

    const categoryIds = new Set();
    const categories = [];
    for (const a of articles) {
      if (a.category && !categoryIds.has(a.category.id)) {
        categoryIds.add(a.category.id);
        categories.push({
          name: a.category.name,
          slug: a.category.slug,
          description: a.category.description || null,
        });
      }
    }

    const exportData = {
      tenantId: TENANT_ID,
      exportedAt: new Date().toISOString(),
      metadata: {
        tenantId: TENANT_ID,
        exportedAt: new Date().toISOString(),
        articleCount: articles.length,
        categoryCount: categories.length,
      },
      categories,
      articles: articles.map(serializeForExport),
    };

    const dir = path.dirname(EXPORT_OUTPUT_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(EXPORT_OUTPUT_PATH, JSON.stringify(exportData, null, 2), 'utf8');
    console.log('Exported', articles.length, 'articles and', categories.length, 'categories to', EXPORT_OUTPUT_PATH);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await app.destroy();
  }
  process.exit(process.exitCode || 0);
}

main();
