'use strict';

const requestContext = require('../utils/request-context');

module.exports = (_config, _opts) => {
  return async (context, next) => {
    return requestContext.run(context, () => next());
  };
};
