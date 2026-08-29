module.exports = {
  test: {
    // Frontend tests run in the client Vitest/jsdom project below. Keeping
    // them out of the Node test project prevents a browser test from being
    // accidentally executed without document/window globals.
    exclude: ['client/**', 'node_modules/**'],
  },
};
