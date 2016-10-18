module.exports = (wallaby) => {
  return {
    files: [
      'package.json',
      'src/**/*.ts',
      'test/*.ts'
    ],

    tests: [
      'test/**/*-test.ts'
    ],

    env: {
      type: 'node'
    },

    testFramework: 'mocha',

    debug: false
  };
};
