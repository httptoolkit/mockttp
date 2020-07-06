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
            devtool: 'source-map',
            resolve: { extensions: ['.ts', '.js'] },
            module: {
                loaders: [
                    { test: /fs-extra|http2/, loader: 'null-loader' },
                    { test: /\.ts$/, loader: 'ts-loader', exclude: /node_modules/ }
                ]
            },
            node: {
                fs: 'empty',
                net: 'empty',
                tls: 'empty',
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