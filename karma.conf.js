const tmp = require('tmp');
tmp.setGracefulCleanup();

const webpack = require('webpack');

module.exports = function(config) {
    config.set({
        frameworks: ['mocha', 'chai'],
        files: [
            'test/**/*.spec.ts'
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
                    "http-proxy-agent$": require.resolve('./test/empty-stub.js'),
                    "https-proxy-agent$": require.resolve('./test/empty-stub.js'),
                    "request-promise-native$": require.resolve('./test/empty-stub.js'),
                    "fs-extra$": require.resolve('./test/empty-stub.js'),
                    "portfinder$": require.resolve('./test/empty-stub.js')
                }
            },
            module: {
                rules: [
                    { test: /\.ts$/, loader: 'ts-loader', exclude: /node_modules/ }
                ]
            },
            node: {
                fs: 'empty', // Only required because brotli includes an unused 'fs' dependency
                __dirname: true
            },
            plugins: [
                new webpack.DefinePlugin({
                    "process.version": '"' + process.version + '"'
                })
            ],
            output: {
                path: tmp.dirSync()
            }
        },
        webpackMiddleware: {
            stats: 'error-only'
        },
        preprocessors: {
            'src/**/*.ts': ['webpack', 'sourcemap'],
            'test/**/*.ts': ['webpack', 'sourcemap']
        },
        reporters: ['progress'],
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
        singleRun: true,
        concurrency: Infinity
    });
};