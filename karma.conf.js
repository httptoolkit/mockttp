const tmp = require('tmp');
tmp.setGracefulCleanup();

const webpack = require('webpack');
const outputDir = tmp.dirSync({ unsafeCleanup: true }).name;

// Run a websocket server in the background for testing
require('./test/fixtures/websocket-test-server');

module.exports = function(config) {
    config.set({
        frameworks: ['mocha', 'chai', 'webpack'],
        files: [
            'test/**/*.spec.ts',
            // Required for wasm due to https://github.com/ryanclark/karma-webpack/issues/498. Results
            // in an annoying warning before the webpack build, but then it works fine.
            { pattern: `${outputDir}/**/*`, included: false, served: true }
        ],
        mime: { 'text/x-typescript': ['ts'] },
        webpack: {
            mode: 'development',
            devtool: 'source-map',
            resolve: {
                extensions: ['.ts', '.js'],
                alias: {
                    // Here we put stubs for non-browser modules that are used by tests, not core code.
                    // Core code stubs are set in pkgJson.browser.
                    "http-proxy-agent": require.resolve('./test/empty-stub.js'),
                    "https-proxy-agent": require.resolve('./test/empty-stub.js'),
                    "request-promise-native": require.resolve('./test/empty-stub.js'),
                    "fs-extra": require.resolve('./test/empty-stub.js'),
                    "portfinder": require.resolve('./test/empty-stub.js'),
                    "dns2": require.resolve('./test/empty-stub.js')
                },
                fallback: {
                    // With Webpack 5, we need explicit mocks for all node modules. Because the
                    // tests are the same for node & browser, with tests simply skipped in
                    // browsers, plus some actual deps on node modules, we end up with a bunch
                    // of deps that need to be manually included/skipped here:
                    fs: false,
                    net: false,
                    http: false,
                    https: false,
                    http2: false,
                    tls: false,

                    assert: require.resolve('assert/'),
                    buffer: require.resolve('buffer/'),
                    crypto: require.resolve('crypto-browserify'),
                    zlib: require.resolve('browserify-zlib'),
                    stream: require.resolve('stream-browserify'),
                    path: require.resolve('path-browserify'),
                    querystring: require.resolve('querystring-es3'),
                    util: require.resolve('util/'),
                    url: require.resolve('url/')
                }
            },
            module: {
                rules: [
                    { test: /\.ts$/, loader: 'ts-loader', exclude: /node_modules/ }
                ]
            },
            experiments: {
                asyncWebAssembly: true
            },
            node: {
                __dirname: true
            },
            plugins: [
                new webpack.SourceMapDevToolPlugin({
                    test: /\.(ts|js|css)($|\?)/i
                }),
                new webpack.ProvidePlugin({
                    process: 'process/browser',
                    Buffer: ['buffer', 'Buffer'],
                })
            ],
            output: {
                path: outputDir
            }
        },
        webpackMiddleware: {
            stats: 'error-only'
        },
        preprocessors: {
            'src/**/*.ts': ['webpack', 'sourcemap'],
            'test/**/*.ts': ['webpack', 'sourcemap']
        },
        plugins: [
            'karma-chrome-launcher',
            'karma-chai',
            'karma-mocha',
            'karma-sourcemap-loader',
            'karma-webpack',
            'karma-spec-reporter'
        ],
        reporters: ['spec'],
        port: 9876,
        logLevel: config.LOG_INFO,

        browsers: ['ChromeHeadlessWithCert'],
        customLaunchers: {
            ChromeHeadlessWithCert: {
                base: 'ChromeHeadless',
                // This is the fingerprint for the test-ca.pem CA cert
                flags: ['--ignore-certificate-errors-spki-list=dV1LxiEDeQEtLjeMCGZ4ON7Mu1TvULkgt/kg1DGk/vM=']
            },
            // Used for debugging (npm run test:browser:debug)
            ChromeWithCert: {
                base: 'Chrome',
                // This is the fingerprint for the test-ca.pem CA cert
                flags: ['--ignore-certificate-errors-spki-list=dV1LxiEDeQEtLjeMCGZ4ON7Mu1TvULkgt/kg1DGk/vM=']
            }
        },

        autoWatch: false,
        singleRun: true
    });
};