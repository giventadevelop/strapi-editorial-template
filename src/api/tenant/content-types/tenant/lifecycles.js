'use strict';

const { applyKebabSlugToEvent } = require('../../../../utils/normalize-slug');

module.exports = {
  beforeCreate(event) {
    applyKebabSlugToEvent(event);
  },
  beforeUpdate(event) {
    applyKebabSlugToEvent(event);
  },
};
