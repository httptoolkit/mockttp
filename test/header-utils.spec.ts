import {
    h1HeadersToH2,
    h2HeadersToH1,
    updateRawHeaders
} from "../src/util/header-utils";
import { expect } from "./test-utils";

describe("Header utils", () => {

    describe("updateRawHeaders", () => {

        it("flattens headers and adds them, if there are no conflicts", () => {
            expect(
                updateRawHeaders([], {
                    'foo': ['bar', 'baz']
                })
            ).to.deep.equal([
                ['foo', 'bar'],
                ['foo', 'baz']
            ]);
        });

        it("preserves header casing", () => {
            expect(
                updateRawHeaders([
                    ['A', 'b'],
                    ['a', 'b']
                ], {
                    'FOO': ['bar', 'baz']
                })
            ).to.deep.equal([
                ['A', 'b'],
                ['a', 'b'],
                ['FOO', 'bar'],
                ['FOO', 'baz']
            ]);
        });

        it("preserves header casing", () => {
            expect(
                updateRawHeaders([
                    ['A', 'b'],
                    ['a', 'b']
                ], {
                    'FOO': ['bar', 'baz']
                })
            ).to.deep.equal([
                ['A', 'b'],
                ['a', 'b'],
                ['FOO', 'bar'],
                ['FOO', 'baz']
            ]);
        });

        it("overrides existing headers", () => {
            expect(
                updateRawHeaders([
                    ['A', 'b'],
                    ['C', 'd'],
                    ['a', 'x'],
                ], {
                    'a': 'c'
                })
            ).to.deep.equal([
                ['C', 'd'],
                ['a', 'c']
            ]);
        });

        it("overrides all values of consecutive duplicate headers", () => {
            expect(
                updateRawHeaders([
                    ['Accept', 'text/html'],
                    ['ACCEPT', 'text/plain'],
                    ['accept', 'image/png'],
                    ['Host', 'example.com']
                ], {
                    'Accept': '*/*'
                })
            ).to.deep.equal([
                ['Host', 'example.com'],
                ['Accept', '*/*']
            ]);
        });

        it("deletes all values of consecutive duplicate headers", () => {
            expect(
                updateRawHeaders([
                    ['Via', '1.1 proxy-a'],
                    ['via', '1.1 proxy-b'],
                    ['Host', 'example.com']
                ], {
                    'VIA': undefined
                })
            ).to.deep.equal([
                ['Host', 'example.com']
            ]);
        });

        it("deletes existing headers when given an empty value", () => {
            expect(
                updateRawHeaders([
                    ['A', 'b'],
                    ['C', 'd']
                ], {
                    'a': undefined
                })
            ).to.deep.equal([
                ['C', 'd']
            ]);
        });

    });

    describe("h1HeadersToH2", () => {

        it("drops connection-specific headers, in any case", () => {
            expect(h1HeadersToH2([
                ['Connection', 'keep-alive'],
                ['keep-alive', 'timeout=5'],
                ['Proxy-Connection', 'keep-alive'],
                ['Transfer-Encoding', 'chunked'],
                ['upgrade', 'websocket'],
                ['HTTP2-Settings', 'AAMAAABkAARAAAAAAAIAAAAA'],
                ['x-other', 'value']
            ])).to.deep.equal([
                ['x-other', 'value']
            ]);
        });

        it("drops host headers, which :authority replaces", () => {
            expect(h1HeadersToH2([
                ['Host', 'example.com']
            ])).to.deep.equal([]);
        });

        it("reduces TE to exactly 'trailers', if trailers are accepted", () => {
            expect(h1HeadersToH2([
                ['TE', 'Trailers, deflate;q=0.5']
            ])).to.deep.equal([
                ['TE', 'trailers']
            ]);
        });

        it("drops TE if trailers aren't accepted", () => {
            expect(h1HeadersToH2([
                ['te', 'gzip']
            ])).to.deep.equal([]);
        });

    });

    describe("h2HeadersToH1", () => {

        it("combines cookie headers where the first one was, keeping everything else in order", () => {
            expect(
                h2HeadersToH1([
                    [':method', 'GET'],
                    [':authority', 'example.com'],
                    ['x-first', '1'],
                    ['x-dup', 'a'],
                    ['cookie', 'session=abc'],
                    ['x-empty', ''],
                    ['x-dup', 'b'],
                    ['COOKIE', 'preferences=dark-mode'],
                    ['x-last', 'z']
                ], 'GET')
            ).to.deep.equal([
                ['Host', 'example.com'],
                ['x-first', '1'],
                ['x-dup', 'a'],
                ['Cookie', 'session=abc; preferences=dark-mode'],
                ['x-empty', ''],
                ['x-dup', 'b'],
                ['x-last', 'z']
            ]);
        });

        it("uses the casing browsers use over HTTP/1, for lowercase names that they generate", () => {
            expect(
                h2HeadersToH1([
                    [':authority', 'example.com'],
                    ['user-agent', 'test-agent'],
                    ['sec-fetch-site', 'same-origin'],
                    ['dnt', '1'],
                    // Browsers send client hints in lowercase over HTTP/1 too:
                    ['sec-ch-ua', '"Chromium";v="153"'],
                    ['x-custom-header', 'value'],
                    // Any other casing was set by a rule:
                    ['ACCEPT', '*/*']
                ], 'GET')
            ).to.deep.equal([
                ['Host', 'example.com'],
                ['User-Agent', 'test-agent'],
                ['Sec-Fetch-Site', 'same-origin'],
                ['DNT', '1'],
                ['sec-ch-ua', '"Chromium";v="153"'],
                ['x-custom-header', 'value'],
                ['ACCEPT', '*/*']
            ]);
        });

        it("adds chunked encoding to bodied requests with no framing headers", () => {
            expect(
                h2HeadersToH1([
                    [':authority', 'example.com'],
                    ['content-type', 'text/plain']
                ], 'POST')
            ).to.deep.equal([
                ['Host', 'example.com'],
                ['Content-Type', 'text/plain'],
                ['Transfer-Encoding', 'chunked']
            ]);
        });

        it("does not add chunked encoding when it's already set", () => {
            expect(
                h2HeadersToH1([
                    [':authority', 'example.com'],
                    ['transfer-encoding', 'gzip, chunked']
                ], 'POST')
            ).to.deep.equal([
                ['Host', 'example.com'],
                ['Transfer-Encoding', 'gzip, chunked']
            ]);
        });

        it("adds chunked encoding when other encodings are set without it", () => {
            expect(
                h2HeadersToH1([
                    [':authority', 'example.com'],
                    ['transfer-encoding', 'gzip']
                ], 'POST')
            ).to.deep.equal([
                ['Host', 'example.com'],
                ['Transfer-Encoding', 'gzip'],
                ['Transfer-Encoding', 'chunked']
            ]);
        });

    });

});
