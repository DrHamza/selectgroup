const { handleApi } = require('./handler');

module.exports = async (req, res) => {
  return handleApi(req, res);
};
