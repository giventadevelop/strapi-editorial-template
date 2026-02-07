'use strict';

/**
 * bishop service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::bishop.bishop');
