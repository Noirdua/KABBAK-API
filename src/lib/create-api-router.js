const express = require("express");

const WRAPPED_ROUTER_METHODS = ["all", "get", "post", "put", "patch", "delete", "options", "head", "use"];

function isHandlerEntry(value) {
  return typeof value === "function" || Array.isArray(value);
}

function isExpressRouter(value) {
  return typeof value === "function"
    && Array.isArray(value.stack)
    && typeof value.handle === "function"
    && typeof value.use === "function";
}

function wrapHandler(handler) {
  if (typeof handler !== "function" || handler.length >= 4 || isExpressRouter(handler)) {
    return handler;
  }

  return function wrappedHandler(request, response, next) {
    try {
      const result = handler(request, response, next);
      Promise.resolve(result).catch(next);
    } catch (error) {
      next(error);
    }
  };
}

function wrapHandlers(handlers) {
  return handlers.flatMap((handler) => {
    if (Array.isArray(handler)) {
      return wrapHandlers(handler);
    }

    return wrapHandler(handler);
  });
}

function createApiRouter() {
  const router = express.Router();

  WRAPPED_ROUTER_METHODS.forEach((methodName) => {
    const originalMethod = router[methodName].bind(router);

    router[methodName] = (...args) => {
      const firstHandlerIndex = args.findIndex(isHandlerEntry);
      if (firstHandlerIndex < 0) {
        return originalMethod(...args);
      }

      return originalMethod(
        ...args.slice(0, firstHandlerIndex),
        ...wrapHandlers(args.slice(firstHandlerIndex))
      );
    };
  });

  return router;
}

module.exports = {
  createApiRouter
};