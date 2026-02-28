'use strict';

/**
 * liturgy-day service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::liturgy-day.liturgy-day');
