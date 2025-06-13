import { Duplex } from 'stream';
import { DocumentNode } from "graphql";
import { IResolvers } from "@graphql-tools/utils";
import { MaybePromise } from "@httptoolkit/util";

export interface AdminPlugin<StartParams, ClientResponse> {
    // Called when a /start request is received that references this plugin
    start: (options: StartParams) => MaybePromise<ClientResponse>;
    stop: () => MaybePromise<void>;
    reset?: () => MaybePromise<void>;
    enableDebug?: () => void,
    schema: DocumentNode | string;
    buildResolvers: (stream: Duplex, ruleParameters: { [key: string]: any }) => IResolvers
}

export type AdminPluginConstructor<Plugin> = { new(): Plugin };

export type PluginStartParams<Plugin> = Plugin extends AdminPlugin<infer StartParams, any>
    ? StartParams
    : never;

export type PluginStartDefaults<Plugins extends { [key: string]: AdminPlugin<any, any> }> = {
    [key in keyof Plugins]?: Partial<PluginStartParams<Plugins[key]>>
};

export type PluginClientResponse<Plugin> = Plugin extends AdminPlugin<any, infer ClientResponse>
    ? ClientResponse
    : never;

export type PluginConstructorMap<Plugins> = { [key in keyof Plugins]: AdminPluginConstructor<Plugins[key]> };
export type PluginStartParamsMap<Plugins> = { [key in keyof Plugins]: PluginStartParams<Plugins[key]> };
export type PluginClientResponsesMap<Plugins> = { [key in keyof Plugins]: PluginClientResponse<Plugins[key]> };