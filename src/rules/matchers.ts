import * as _ from 'lodash';
import * as url from 'url';
import { oneLine } from 'common-tags';
import * as multipart from 'parse-multipart-data';

import { CompletedRequest, Method, Explainable, OngoingRequest } from "../types";
import {
    isAbsoluteUrl,
    getPathFromAbsoluteUrl,
    isRelativeUrl,
    getUrlWithoutProtocol,
    normalizeUrl
} from '../util/url';
import { waitForCompletedRequest } from '../util/request-utils';
import { Serializable, ClientServerChannel } from "../serialization/serialization";
import { withDeserializedBodyReader, withSerializedBodyReader } from '../serialization/body-serialization';
import { MaybePromise, Replace } from '../util/type-utils';

export interface RequestMatcher extends Explainable, Serializable {
    type: keyof typeof MatcherLookup;
    matches(request: OngoingRequest): MaybePromise<boolean>;
}

export interface SerializedCallbackMatcherData {
    type: string;
    name?: string;
    version?: number;
}

function unescapeRegexp(input: string): string {
    return input.replace(/\\\//g, '/');
}

export class WildcardMatcher extends Serializable implements RequestMatcher {
    readonly type = 'wildcard';

    matches() {
        return true;
    }

    explain() {
        return 'for anything';
    }
}

export class MethodMatcher extends Serializable implements RequestMatcher {
    readonly type = 'method';

    constructor(
        public method: Method
    ) {
        super();
    }

    matches(request: OngoingRequest) {
        return request.method === Method[this.method];
    }

    explain() {
        return `making ${Method[this.method]}s`;
    }
}

export class ProtocolMatcher extends Serializable implements RequestMatcher {
    readonly type = 'protocol';

    constructor(
        public protocol: "http" | "https" | "ws" | "wss"
    ) {
        super();
        if (
            protocol !== "http" &&
            protocol !== "https" &&
            protocol !== "ws" &&
            protocol !== "wss"
        ) {
            throw new Error(
                "Invalid protocol: protocol can only be 'http', 'https', 'ws' or 'wss'"
            );
        }
    }

    matches(request: OngoingRequest) {
        return request.protocol === this.protocol;
    }

    explain() {
        return `for protocol ${this.protocol}`;
    }
}

export class HostMatcher extends Serializable implements RequestMatcher {
    readonly type = 'host';

    constructor(
        public host: string
    ) {
        super();

        // Validate the hostname. Goal here isn't to catch every bad hostname, but allow
        // every good hostname, and provide friendly errors for obviously bad hostnames.
        if (host.includes('/')) {
            throw new Error("Invalid hostname: hostnames can't contain slashes");
        } else if (host.includes('?')) {
            throw new Error("Invalid hostname: hostnames can't contain query strings");
        } else if (!host.match(/^([a-zA-Z0-9\-]+\.)*[a-zA-Z0-9\-]+(:\d+)?$/)) { // Port optional
            throw new Error("Hostname is invalid");
        }
    }

    matches(request: OngoingRequest) {
        const parsedUrl = new url.URL(request.url);

        if (
            (this.host.endsWith(':80') && request.protocol === 'http') ||
            (this.host.endsWith(':443') && request.protocol === 'https')
        ) {
            // On default ports, our URL normalization erases an explicit port, so that a
            // :80 here will never match anything. This handles that case: if you send HTTP
            // traffic on port 80 then the port is blank, but it should match for 'hostname:80'.
            return parsedUrl.hostname === this.host.split(':')[0] && parsedUrl.port === '';
        } else {
            return parsedUrl.host === this.host;
        }
    }

    explain() {
        return `for host ${this.host}`;
    }
}

export class HostnameMatcher extends Serializable implements RequestMatcher {
    readonly type = 'hostname';

    constructor(
        public readonly hostname: string
    ) {
        super();

        // Validate the hostname. Goal here isn't to catch every bad hostname, but allow
        // every good hostname, and provide friendly errors for obviously bad hostnames.
        if (hostname.includes('/')) {
            throw new Error("Invalid hostname: hostnames can't contain slashes");
        } else if (hostname.includes('?')) {
            throw new Error("Invalid hostname: hostnames can't contain query strings");
        } else if (!hostname.match(/^([a-zA-Z0-9\-]+\.)*[a-zA-Z0-9\-]+$/)) { // No port
            throw new Error("Hostname is invalid");
        }
    }

    matches(request: OngoingRequest) {
        return new url.URL(request.url).hostname === this.hostname;
    }

    explain() {
        return `for hostname ${this.hostname}`;
    }
}

export class PortMatcher extends Serializable implements RequestMatcher {
    readonly type = 'port';

    public port: string;

    constructor(port: number) {
        super();
        this.port = port.toString();
    }

    matches(request: OngoingRequest) {
        const parsedUrl = new url.URL(request.url);

        if (
            (this.port === '80' && request.protocol === 'http') ||
            (this.port === '443' && request.protocol === 'https')
        ) {
            // The port is erased during our URL preprocessing if it's the default,
            // so for those cases we have to match that separately:
            return parsedUrl.port === '';
        } else {
            return new url.URL(request.url).port === this.port;
        }
    }

    explain() {
        return `for port ${this.port}`;
    }
}

export class SimplePathMatcher extends Serializable implements RequestMatcher {
    readonly type = 'simple-path';

    constructor(
        public path: string
    ) {
        super();

        if (!this.path) throw new Error('Invalid URL: URL to match must not be empty');

        let { search, query } = url.parse(this.path, true);
        if (search) {
            throw new Error(oneLine`
                Tried to match a path that contained a query (${search}).
                To match query parameters, use .withQuery(${JSON.stringify(query)}) instead,
                or .withExactQuery('${search}') to match this exact query string.
            `);
        }

        normalizeUrl(this.path); // Fail if URL can't be normalized
    }

    matches(request: OngoingRequest) {
        const expectedUrl = normalizeUrl(this.path);
        const reqUrl = normalizeUrl(request.url);

        // reqUrl is always absolute, expectedUrl can be absolute, relative or protocolless-absolute

        if (isRelativeUrl(expectedUrl)) {
            // Match the path only, for any host
            return getPathFromAbsoluteUrl(reqUrl) === expectedUrl;
        } else if (isAbsoluteUrl(expectedUrl)) {
            // Full absolute URL: match everything
            return reqUrl === expectedUrl;
        } else {
            // Absolute URL with no protocol
            return getUrlWithoutProtocol(reqUrl) === expectedUrl;
        }
    }

    explain() {
        return `for ${this.path}`;
    }
}

export class RegexPathMatcher extends Serializable implements RequestMatcher {
    readonly type = 'regex-path';

    readonly regexSource: string;
    readonly regexFlags: string;

    constructor(regex: RegExp) {
        super();
        this.regexSource = regex.source;
        this.regexFlags = regex.flags;
    }

    matches(request: OngoingRequest) {
        const absoluteUrl = normalizeUrl(request.url);
        const urlPath = getPathFromAbsoluteUrl(absoluteUrl);

        // Test the matcher against both the path alone & the full URL
        const urlMatcher = new RegExp(this.regexSource, this.regexFlags);
        return urlMatcher.test(absoluteUrl) ||
            urlMatcher.test(urlPath);
    }

    explain() {
        return `matching /${unescapeRegexp(this.regexSource)}/${this.regexFlags ?? ''}`;
    }

}

export class RegexUrlMatcher extends Serializable implements RequestMatcher {
    readonly type = 'regex-url';

    readonly regexSource: string;
    readonly regexFlags: string;

    constructor(regex: RegExp) {
        super();
        this.regexSource = regex.source;
        this.regexFlags = regex.flags;
    }

    matches(request: OngoingRequest) {
        const absoluteUrl = normalizeUrl(request.url);

        // Test the matcher against the full URL
        const urlMatcher = new RegExp(this.regexSource, this.regexFlags);
        return urlMatcher.test(absoluteUrl);
    }

    explain() {
        return `matching URL /${unescapeRegexp(this.regexSource)}/${this.regexFlags ?? ''}`;
    }

}

export class HeaderMatcher extends Serializable implements RequestMatcher {
    readonly type = 'header';

    public headers: { [key: string]: string };

    constructor(headersInput: { [key: string]: string }) {
        super();
        this.headers = _.mapKeys(headersInput, (_value: string, key: string) => key.toLowerCase());
    }

    matches(request: OngoingRequest) {
        return _.isMatch(request.headers, this.headers);
    }

    explain() {
        return `with headers including ${JSON.stringify(this.headers)}`;
    }
}

export class ExactQueryMatcher extends Serializable implements RequestMatcher {
    readonly type = 'exact-query-string';

    constructor(
        public query: string
    ) {
        super();

        if (query !== '' && query[0] !== '?') {
            throw new Error('Exact query matches must start with ?, or be empty');
        }
    }

    matches(request: OngoingRequest) {
        const { search } = url.parse(request.url);
        return this.query === search || (!search && !this.query);
    }

    explain() {
        return this.query
            ? `with a query exactly matching \`${this.query}\``
            : 'with no query string';
    }
}

export class QueryMatcher extends Serializable implements RequestMatcher {
    readonly type = 'query';

    public queryObject: { [key: string]: string | string[] };

    constructor(
        queryObjectInput: { [key: string]: string | number | (string | number)[] },
    ) {
        super();
        this.queryObject = _.mapValues(queryObjectInput, (v) =>
            Array.isArray(v) ? v.map(av => av.toString()) : v.toString()
        );
    }

    matches(request: OngoingRequest) {
        let { query } = url.parse(request.url, true);
        return _.isMatch(query, this.queryObject);
    }

    explain() {
        return `with a query including ${JSON.stringify(this.queryObject)}`;
    }
}

export class FormDataMatcher extends Serializable implements RequestMatcher {
    readonly type = 'form-data';

    constructor(
        public formData: { [key: string]: string }
    ) {
        super();
    }

    async matches(request: OngoingRequest) {
        const contentType = request.headers['content-type'];

        return !!contentType &&
            contentType.indexOf("application/x-www-form-urlencoded") !== -1 &&
            _.isMatch(await request.body.asFormData(), this.formData);
    }

    explain() {
        return `with form data including ${JSON.stringify(this.formData)}`;
    }
}

export type MultipartFieldMatchCondition = {
    name?: string,
    filename?: string,
    content?: string | Uint8Array
};

export class MultipartFormDataMatcher extends Serializable implements RequestMatcher {
    readonly type = 'multipart-form-data';

    constructor(
        public matchConditions: Array<MultipartFieldMatchCondition>
    ) {
        super();
    }

    async matches(request: OngoingRequest) {
        const contentType = request.headers['content-type'];

        if (!contentType) return false;
        if (!contentType.includes("multipart/form-data")) return false;

        const boundary = contentType.match(/;\s*boundary=(\S+)/);
        if (!boundary) return false;

        const parsedBody = multipart.parse(await request.body.asDecodedBuffer(), boundary[1]);

        return this.matchConditions.every((condition) => {
            const expectedContent = typeof condition.content === 'string'
                    ? Buffer.from(condition.content, "utf8")
                : condition.content
                    ? Buffer.from(condition.content)
                : undefined;

            return parsedBody.some((part) =>
                (expectedContent?.equals(part.data) || expectedContent === undefined) &&
                (condition.filename === part.filename || condition.filename === undefined) &&
                (condition.name === part.name || condition.name === undefined)
            );
        });
    }

    explain() {
        return `with multipart form data matching ${JSON.stringify(this.matchConditions)}`;
    }
}

export class RawBodyMatcher extends Serializable implements RequestMatcher {
    readonly type = 'raw-body';

    constructor(
        public content: string
    ) {
        super();
    }

    async matches(request: OngoingRequest) {
        return (await request.body.asText()) === this.content;
    }

    explain() {
        return `with body '${this.content}'`;
    }
}

export class RawBodyIncludesMatcher extends Serializable implements RequestMatcher {
    readonly type = 'raw-body-includes';

    constructor(
        public content: string
    ) {
        super();
    }

    async matches(request: OngoingRequest) {
        return (await request.body.asText()).includes(this.content);
    }

    explain() {
        return `with a body including '${this.content}'`;
    }
}

export class RegexBodyMatcher extends Serializable implements RequestMatcher {
    readonly type = 'raw-body-regexp';
    readonly regexString: string;

    constructor(regex: RegExp) {
        super();
        this.regexString = regex.source;
    }

    async matches(request: OngoingRequest) {
        let bodyMatcher = new RegExp(this.regexString);
        return bodyMatcher.test(await request.body.asText());
    }

    explain() {
        return `with a body matching /${unescapeRegexp(this.regexString)}/`;
    }

}

export class JsonBodyMatcher extends Serializable implements RequestMatcher {
    readonly type = 'json-body';

    constructor(
        public body: {}
    ) {
        super();
    }

    async matches(request: OngoingRequest) {
        const receivedBody = await (request.body.asJson().catch(() => undefined));

        if (receivedBody === undefined) return false;
        else return _.isEqual(receivedBody, this.body)
    }

    explain() {
        return `with a JSON body equivalent to ${JSON.stringify(this.body)}`;
    }

}

export class JsonBodyFlexibleMatcher extends Serializable implements RequestMatcher {
    readonly type = 'json-body-matching';

    constructor(
        public body: {}
    ) {
        super();
    }

    async matches(request: OngoingRequest) {
        const receivedBody = await (request.body.asJson().catch(() => undefined));

        if (receivedBody === undefined) return false;
        else return _.isMatch(receivedBody, this.body)
    }

    explain() {
        return `with a JSON body including ${JSON.stringify(this.body)}`;
    }

}

export class CookieMatcher extends Serializable implements RequestMatcher {
    readonly type = 'cookie';

    constructor(
        public cookie: { [key: string]: string },
    ) {
        super();
    }

    async matches(request: OngoingRequest) {
        if(!request.headers || !request.headers.cookie) {
            return false;
        }

        const cookies = request.headers.cookie.split(';').map(cookie => {
            const [key, value] = cookie.split('=');

            return { [key.trim()]: (value || '').trim()}
        });

        return cookies.some(element => _.isEqual(element, this.cookie));
    }

    explain() {
        return `with cookies including ${JSON.stringify(this.cookie)}`;
    }
}

export class CallbackMatcher extends Serializable implements RequestMatcher {
    readonly type = 'callback';

    constructor(
        public callback: (request: CompletedRequest) => MaybePromise<boolean>
        ) {
        super();
    }

    async matches(request: OngoingRequest) {
        const completedRequest = await waitForCompletedRequest(request);
        return this.callback(completedRequest);
    }

    explain() {
        return `matches using provided callback${
            this.callback.name ? ` (${this.callback.name})` : ''
        }`;
    }

    /**
     * @internal
     */
    serialize(channel: ClientServerChannel): SerializedCallbackMatcherData {
      channel.onRequest<Replace<CompletedRequest, { body: string }>, boolean>(async (streamMsg) => {
        const request = withDeserializedBodyReader(streamMsg);

        const callbackResult = await this.callback.call(null, request);

        return callbackResult;
      });

      return { type: this.type, name: this.callback.name, version: 1 };
    }

    /**
     * @internal
     */
    static deserialize(
      { name }: SerializedCallbackMatcherData,
      channel: ClientServerChannel
    ): CallbackMatcher {
      const rpcCallback = async (request: CompletedRequest) => {
        const callbackResult = channel.request<
            Replace<CompletedRequest, { body: string }>,
            boolean
        >(withSerializedBodyReader(request) as any);

        return callbackResult;
      };
      // Pass across the name from the real callback, for explain()
      Object.defineProperty(rpcCallback, 'name', { value: name });

      // Call the client's callback (via stream), and save a handler on our end for
      // the response that comes back.
      return new CallbackMatcher(rpcCallback);
    }
}

export const MatcherLookup = {
    'wildcard': WildcardMatcher,
    'method': MethodMatcher,
    'protocol': ProtocolMatcher,
    'host': HostMatcher,
    'hostname': HostnameMatcher,
    'port': PortMatcher,
    'simple-path': SimplePathMatcher,
    'regex-path': RegexPathMatcher,
    'regex-url': RegexUrlMatcher,
    'header': HeaderMatcher,
    'query': QueryMatcher,
    'exact-query-string': ExactQueryMatcher,
    'form-data': FormDataMatcher,
    'multipart-form-data': MultipartFormDataMatcher,
    'raw-body': RawBodyMatcher,
    'raw-body-regexp': RegexBodyMatcher,
    'raw-body-includes': RawBodyIncludesMatcher,
    'json-body': JsonBodyMatcher,
    'json-body-matching': JsonBodyFlexibleMatcher,
    'cookie': CookieMatcher,
    'callback': CallbackMatcher,
};

export async function matchesAll(req: OngoingRequest, matchers: RequestMatcher[]): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
        const resultsPromises = matchers.map((matcher) => matcher.matches(req));

        resultsPromises.forEach(async (maybePromiseResult) => {
            try {
                const result = await maybePromiseResult;
                if (!result) resolve(false); // Resolve mismatches immediately
            } catch (e) {
                reject(e); // Resolve matcher failures immediately
            }
        });

        // Otherwise resolve as normal: all true matches, exceptions reject.
        Promise.all(resultsPromises)
            .then((result) => resolve(_.every(result)))
            .catch((e) => reject(e));
    });
}

export function explainMatchers(matchers: RequestMatcher[]) {
    if (matchers.length === 1) return matchers[0].explain();
    if (matchers.length === 2) {
        // With just two explanations, you can just combine them
        return `${matchers[0].explain()} ${matchers[1].explain()}`;
    }

    // With 3+, we need to oxford comma separate explanations to make them readable
    return matchers.slice(0, -1)
    .map((m) => m.explain())
    .join(', ') + ', and ' + matchers.slice(-1)[0].explain();
}