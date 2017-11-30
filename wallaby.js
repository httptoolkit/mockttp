module.exports = (wallaby) => {
  process.env.NODE_EXTRA_CA_CERTS = './test/fixtures/test-ca.pem'

  return {
    files: [
      'package.json',
      'src/**/*.ts',
      'src/**/*.gql',
      'test/**/*.ts',
      'test/fixtures/**/*',
      '!test/**/*-test.ts'
    ],
    tests: [
      'test/**/*-test.ts'
    ],

    preprocessors: {
      // Package.json points `main` to the built output. We use this a lot in the integration tests, but we
      // want wallaby to run on raw source. This is a simple remap of paths to lets us do that.
      'test/integration/*.ts': file => {
        return file.content.replace(
        /("|')..\/..("|')/g,
        '"../../src/main"'
      );
    }
    },

    testFramework: 'mocha',
    env: {
      type: 'node'
    },
    debug: true
  };
};