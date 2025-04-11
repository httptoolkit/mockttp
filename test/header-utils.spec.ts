import { updateRawHeaders } from "../src/util/header-utils";
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

});