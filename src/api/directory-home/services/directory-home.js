'use strict';

/**
 * directory-home service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::directory-home.directory-home');
