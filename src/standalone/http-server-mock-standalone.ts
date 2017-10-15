import fs = require('fs');
import path = require('path');
import express = require('express');
import cors = require('cors');
import destroyable, { DestroyableServer } from "../util/destroyable-server";
import bodyParser = require('body-parser');
import { graphqlExpress } from 'apollo-server-express';
import { GraphQLSchema, GraphQLScalarType } from 'graphql';
import { makeExecutableSchema } from 'graphql-tools';
import HttpServerMockServer from "../server/http-server-mock-server";
import { buildStandaloneModel } from "./standalone-model";
import * as _ from "lodash";
import { DEFAULT_STANDALONE_PORT } from '../types';

export interface StandaloneServerOptions {
    debug?: boolean;
}

export class HttpServerMockStandalone {
    private debug: boolean;
    private app: express.Application = express();
    private server: DestroyableServer | null = null;

    private mockServers: HttpServerMockServer[] = [];

    constructor(options: StandaloneServerOptions = {}) {
        this.debug = options.debug || false;
        if (this.debug) console.log('Standalone server started in debug mode');

        this.app.use(cors());
        this.app.post('/start', async (req, res) => {
            try {
                const port = req.query.port;

                if (port != null && this.routers[port] != null) {
                    res.status(409).json({
                        error: `Cannot start: mock server is already running on port ${port}`
                    });
                    return;
                }

                const { mockPort, mockServer } = await this.startMockServer(port);

                const config: MockServerConfig = {
                    port: mockPort,
                    mockRoot: mockServer.urlFor('')
                };

                res.json(config);
            } catch (e) {
                res.status(500).json({ error: `Failed to start server: ${e.message || e}` });
            }
        });

        // Dynamically route to admin servers ourselves, so we can easily add/remove
        // servers as we see fit later on.
        this.app.use('/server/:port/', (req, res, next) => {
            this.routers[req.params.port](req, res, next);
        });
    }


    private loadSchema(schemaFilename: string, mockServer: HttpServerMockServer): Promise<GraphQLSchema> {
        return new Promise<string>((resolve, reject) => {
            fs.readFile(path.join(__dirname, schemaFilename), 'utf8', (err, schemaString) => {
                if (err) reject(err);
                else resolve(schemaString);
            });
        }).then((schemaString) => makeExecutableSchema({
            typeDefs: schemaString,
            resolvers: buildStandaloneModel(mockServer)
        }));
    }

    async start() {
        if (this.server) throw new Error('Standalone server already running');

        await new Promise<void>((resolve, reject) => {
            this.server = destroyable(this.app.listen(DEFAULT_STANDALONE_PORT, resolve));
        });
    }

    private routers: { [port: number]: express.Router } = { };

    private async startMockServer(port?: number): Promise<{ mockPort: number, mockServer: HttpServerMockServer }> {
        const mockServer = new HttpServerMockServer({
            debug: this.debug,
            cors: true // Standalone servers are primarily for browser usage, and browsers need cors
        });
        this.mockServers.push(mockServer);
        await mockServer.start(port);

        const mockPort = mockServer.port!;

        const mockServerRouter = express.Router();
        this.routers[mockPort] = mockServerRouter;

        mockServerRouter.post('/stop', async (req, res) => {
            await mockServer.stop();

            this.mockServers = _.reject(this.mockServers, mockServer);
            delete this.routers[mockPort];

            res.status(200).send(JSON.stringify({
                success: true
            }));
        });

        mockServerRouter.use(bodyParser.json(), graphqlExpress({
            schema: await this.loadSchema('schema.gql', mockServer)
        }));

        return {
            mockPort,
            mockServer
        };
    }

    stop(): Promise<void> {
        if (!this.server) return Promise.resolve<void>();

        return Promise.all([
            this.server.destroy(),
        ].concat(
            this.mockServers.map((s) => s.stop())
        )).then(() => {
            this.server = null;
        });
    }
}

export interface MockServerConfig {
    port: number,
    mockRoot: string
}