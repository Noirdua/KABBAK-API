function createLogWriter(logger) {
  if (typeof logger?.info === "function") {
    return logger.info.bind(logger);
  }

  if (typeof logger?.log === "function") {
    return logger.log.bind(logger);
  }

  return null;
}

module.exports = {
  createLogWriter
};
