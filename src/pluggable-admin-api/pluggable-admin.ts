/**
 * This file exports the core pluggable admin types, without anything Mockttp-specific
 * included. That's useful so that downstream usage of pluggable without Mockttp doesn't
 * need to load all our dependencies (especially heavy things like brotli-wasm).
 *
 * In future these parts might be extracted into a separate library, but it's a bit tricky
 * to do so immediately as the server side does actually include some unavoidable Mockttp
 * dependencies for API backward compatibility.
 */

export type {
    AdminPlugin,
    PluginStartParams,
    PluginStartParamsMap,
    PluginClientResponse,
    PluginClientResponsesMap
} from "../admin/admin-plugin-types";

export {
    AdminServer,
    type AdminServerOptions
} from "../admin/admin-server";

export type {
    AdminQuery,
    QueryContext
} from "../client/admin-query";
export type {SchemaIntrospector } from "../client/schema-introspection";
export {
    AdminClient,
    type AdminClientOptions
} from "../client/admin-client";

export * as Serialization from '../serialization/serialization';