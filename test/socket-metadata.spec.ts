import { Buffer } from 'buffer';

import { expect, nodeOnly } from './test-utils';
import {
    getSocketMetadata,
    getSocketMetadataFromProxyAuth,
    getSocketMetadataTags
} from '../src/util/socket-metadata';
import { SocketMetadata } from '../src/util/socket-extensions';

const basicAuth = (value: string) =>
    `Basic ${Buffer.from(value).toString('base64')}`;

nodeOnly(() => {
    describe("Socket metadata", () => {

        describe("getSocketMetadata", () => {
            it("parses JSON metadata", () => {
                expect(getSocketMetadata(undefined, '{"tags":["a"]}'))
                    .to.deep.equal({ tags: ['a'] });
            });

            it("parses base64url JSON metadata", () => {
                const input = Buffer.from('{"tags":["a"]}').toString('base64url');
                expect(getSocketMetadata(undefined, input))
                    .to.deep.equal({ tags: ['a'] });
            });

            it("parses buffer metadata", () => {
                expect(getSocketMetadata(undefined, Buffer.from('{"tags":["a"]}')))
                    .to.deep.equal({ tags: ['a'] });
            });

            it("merges with existing metadata", () => {
                expect(getSocketMetadata({ other: 1 }, '{"tags":["a"]}'))
                    .to.deep.equal({ other: 1, tags: ['a'] });
            });

            it("combines arrays with existing metadata", () => {
                expect(getSocketMetadata(
                    { tags: ['a', 'b'], nested: { values: [1] } },
                    '{"tags":["c","a"],"nested":{"values":[2]}}'
                )).to.deep.equal({
                    tags: ['a', 'b', 'c'],
                    nested: { values: [1, 2] }
                });
            });

            it("does not modify the existing metadata", () => {
                const existing = { tags: ['a'], nested: { values: [1] } };
                getSocketMetadata(existing, '{"tags":["b"],"nested":{"values":[2]}}');
                expect(existing).to.deep.equal({ tags: ['a'], nested: { values: [1] } });
            });

            it("ignores non-object JSON", () => {
                const existing = { tags: ['a'] };
                expect(getSocketMetadata(existing, '123')).to.equal(existing);
                expect(getSocketMetadata(existing, 'null')).to.equal(existing);
                expect(getSocketMetadata(existing, '[1,2]')).to.equal(existing);
            });

            it("throws for invalid JSON", () => {
                expect(() => getSocketMetadata(undefined, '')).to.throw();
                expect(() => getSocketMetadata(undefined, Buffer.alloc(0))).to.throw();
                expect(() => getSocketMetadata(undefined, '{')).to.throw();
            });
        });

        describe("getSocketMetadataFromProxyAuth", () => {
            const existing: SocketMetadata = { tags: ['existing'] };
            const socket = { [SocketMetadata]: existing };

            it("reads metadata from basic auth", () => {
                expect(getSocketMetadataFromProxyAuth({},
                    basicAuth('metadata:{"tags":["a"]}')
                )).to.deep.equal({ tags: ['a'] });
            });

            it("reads metadata with a case-insensitive auth scheme", () => {
                expect(getSocketMetadataFromProxyAuth({},
                    basicAuth('metadata:{"tags":["a"]}').replace('Basic', 'bAsIc')
                )).to.deep.equal({ tags: ['a'] });
            });

            it("reads metadata with extra whitespace after the auth scheme", () => {
                expect(getSocketMetadataFromProxyAuth({},
                    basicAuth('metadata:{"tags":["a"]}').replace(' ', '   ')
                )).to.deep.equal({ tags: ['a'] });
            });

            it("combines tags with existing socket metadata", () => {
                expect(getSocketMetadataFromProxyAuth(socket,
                    basicAuth('metadata:{"tags":["a"]}')
                )).to.deep.equal({ tags: ['existing', 'a'] });
            });

            it("keeps colons within the password", () => {
                expect(getSocketMetadataFromProxyAuth({},
                    basicAuth('metadata:{"tags":["a:b"]}')
                )).to.deep.equal({ tags: ['a:b'] });
            });

            for (const value of [
                '',
                'Basic',
                'basic',
                'Basic ',
                'Basic  ',
                'Bearer abc',
                basicAuth('metadata'),
                basicAuth('metadata:'),
                basicAuth('metadata:{'),
                basicAuth('other:{"tags":["a"]}'),
                basicAuth(':{"tags":["a"]}'),
                basicAuth('metadata:"string"'),
                'Basic !!!not-base64!!!'
            ]) {
                it(`returns the existing metadata given ${JSON.stringify(value)}`, () => {
                    expect(getSocketMetadataFromProxyAuth(socket, value)).to.equal(existing);
                });
            }
        });

        describe("getSocketMetadataTags", () => {
            it("returns no tags for missing metadata", () => {
                expect(getSocketMetadataTags(undefined)).to.deep.equal([]);
                expect(getSocketMetadataTags({})).to.deep.equal([]);
            });

            it("prefixes tags", () => {
                expect(getSocketMetadataTags({ tags: ['a', 'b'] }))
                    .to.deep.equal(['socket-metadata:a', 'socket-metadata:b']);
            });

            it("ignores invalid tags", () => {
                const tagsFrom = (json: string) =>
                    getSocketMetadataTags(getSocketMetadata(undefined, json));

                expect(tagsFrom('{"tags":"a"}')).to.deep.equal([]);
                expect(tagsFrom('{"tags":{"length":1}}')).to.deep.equal([]);
                expect(tagsFrom('{"tags":["a",1,null,{"b":1}]}'))
                    .to.deep.equal(['socket-metadata:a']);
            });
        });
    });
});
