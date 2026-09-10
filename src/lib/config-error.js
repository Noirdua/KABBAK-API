function createConfigError(message) {
  const error = new Error(message);
  error.code = "invalid_configuration";
  return error;
}

module.exports = {
  createConfigError
};
