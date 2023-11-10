const path = require('path');

module.exports = (wallaby) => {
  return {
    files: [
      'package.json',
      'src/**/*.ts',
      'src/**/*.gql',
      'test/**/*.ts',
      { pattern: 'test/fixtures/**/*.pfx', load: false, binary: true },
      'test/fixtures/**/*',
      '!test/**/*.spec.ts'
    ],
    tests: [
      'test/**/*.spec.ts'
    ],

    preprocessors: {
      // Package.json points `main` to the built output. We use this a lot in the integration tests, but we
      // want wallaby to run on raw source. This is a simple remap of paths to lets us do that.
      'test/integration/**/*.ts': file => {
        return file.content.replace(
          /("|')..((\/..)+)("|')/g,
          '"..$2/src/main"'
        );
      }
    },

    workers: {
      initial: 1,
      regular: 1,
      restart: true
    },

    testFramework: 'mocha',
    env: {
      type: 'node',
      params: {
        env: `NODE_EXTRA_CA_CERTS=${path.resolve(__dirname, 'test/fixtures/test-ca.pem')}`
      }
    },
    debug: true
  };
};