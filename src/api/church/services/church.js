'use strict';

/**
 * church service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::church.church');
