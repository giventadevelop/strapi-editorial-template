'use strict';

/**
 * Seed flash news for tenant_demo_002 and ensure mosc.regular.user has Editor Tenant Assignment.
 * Run after Strapi is set up: node scripts/seed-flash-news.js
 * (from project root, with Strapi deps installed)
 */

const EDITOR_EMAIL = 'mosc.regular.user@keleno.com';
const TENANT_ID = 'tenant_demo_002';

const SAMPLE_FLASH_ITEMS = [
  { title: 'Welcome', content: 'Welcome to the news portal. Stay tuned for the latest updates.', order: 1, externalUrl: 'https://example.com/welcome' },
  { title: 'Latest updates', content: 'Latest updates and announcements from the team.', order: 2 },
  { title: 'Important notice', content: 'Important notice for all readers. Please check our news section for details.', order: 3, externalUrl: 'https://example.com/notice' },
];

async function ensureEditorTenantAssignment(strapi, tenantId) {
  const tenant = await strapi.db.query('api::tenant.tenant').findOne({
    where: { tenantId },
    select: ['id', 'documentId'],
  });
  if (!tenant) {
    console.warn(`Tenant with tenantId "${tenantId}" not found. Create it in Strapi Admin (Content Manager → Tenant).`);
    return null;
  }

  const existing = await strapi.db.query('api::editor-tenant.editor-tenant').findOne({
    where: { adminUserEmail: EDITOR_EMAIL },
  });
  if (existing) {
    console.log(`Editor Tenant Assignment already exists for ${EDITOR_EMAIL}`);
    return tenant;
  }

  await strapi.db.query('api::editor-tenant.editor-tenant').create({
    data: {
      adminUserEmail: EDITOR_EMAIL,
      tenant: tenant.id,
    },
  });
  console.log(`Created Editor Tenant Assignment: ${EDITOR_EMAIL} → tenant ${tenantId}`);
  return tenant;
}

async function seedFlashNewsItems(strapi, tenant) {
  const result = await strapi.documents('api::flash-news-item.flash-news-item').findMany({
    filters: { tenant: tenant.id },
    limit: 1,
  });
  const existing = result?.results ?? result?.data ?? (Array.isArray(result) ? result : []);
  if (existing.length > 0) {
    console.log(`Flash News Items already exist for tenant (${existing.length}). Skipping.`);
    return;
  }

  const now = new Date().toISOString();
  for (const item of SAMPLE_FLASH_ITEMS) {
    await strapi.documents('api::flash-news-item.flash-news-item').create({
      data: {
        title: item.title,
        content: item.content,
        order: item.order ?? 0,
        externalUrl: item.externalUrl || null,
        tenant: tenant.id,
        publishedAt: now,
      },
    });
  }
  console.log(`Created ${SAMPLE_FLASH_ITEMS.length} Flash News Items for tenant ${TENANT_ID}`);
}

async function main() {
  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  try {
    const tenant = await ensureEditorTenantAssignment(app, TENANT_ID);
    if (tenant) await seedFlashNewsItems(app, tenant);
  } finally {
    await app.destroy();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
