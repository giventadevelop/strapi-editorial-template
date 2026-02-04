'use strict';

/**
 * editor-tenant service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::editor-tenant.editor-tenant');
