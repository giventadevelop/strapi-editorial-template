'use strict';

/**
 * priest service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::priest.priest');
