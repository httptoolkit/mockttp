const tmp = require('tmp');
tmp.setGracefulCleanup();

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
                    { test: /\.ts$/, loader: 'ts-loader', exclude: /node_modules/ }
                ]
            },
            node: {
                fs: 'empty',
                net: 'empty',
                tls: 'empty'
            },
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

        browsers: ['ChromeWithCert'],
        customLaunchers: {
            ChromeWithCert: {
                base: 'Chrome', // TODO: Find a way to ignore certs with ChromeHeadless in here
                // This is the fingerprint for the test-ca.pem CA cert
                flags: ['--ignore-certificate-errors-spki-list=AvVrqB/anBbJ+KRCMH/anWgZbeE0Y28JtqYB0+2MDmE=']
            }
        },

        autoWatch: false,
        singleRun: true,
        concurrency: Infinity
    });
};