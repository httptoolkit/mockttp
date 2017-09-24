import fs = require('fs');
import path = require('path');
import express = require('express');
import destroyable, { DestroyableServer } from "../destroyable-server";
import bodyParser = require('body-parser');
import { graphqlExpress } from 'apollo-server-express';
import { buildSchema, GraphQLSchema } from 'graphql';
import HttpServerMockServer from "../http-server-mock-server";
import { StandaloneModel } from "./standalone-model";
import * as _ from "lodash";

export const DEFAULT_PORT = 45456;

export class HttpServerMockStandalone {
    private app: express.Application = express();
    private server: DestroyableServer | null = null;

    private schema: Promise<GraphQLSchema>;
    private mockServers: HttpServerMockServer[] = [];

    constructor() {
        this.schema = this.loadSchema('schema.gql');

        this.app.post('/start', async (req, res) => {
            const port = req.query.port;

            const mockServerPath = await this.startMockServer(port);

            const config: MockServerConfig = {
                root: `http://localhost:${this.server!.address().port}${mockServerPath}`
            };

            res.json(config);
        });
    }

    private loadSchema(schemaFilename: string): Promise<GraphQLSchema> {
        return new Promise((resolve, reject) => {
            fs.readFile(path.join(__dirname, schemaFilename), 'utf8', (err, schemaString) => {
                if (err) reject(err);
                else resolve(buildSchema(schemaString));
            });
        });
    }

    async start() {
        if (this.server) throw new Error('Standalone server already running');

        // Make sure the mock schema is ready before we start the admin server
        await this.schema;

        await new Promise<void>((resolve, reject) => {
            this.server = destroyable(this.app.listen(DEFAULT_PORT, resolve));
        });
    }

    private async startMockServer(port?: number): Promise<string> {
        const mockServer = new HttpServerMockServer();
        this.mockServers.push(mockServer);
        await mockServer.start(port);

        const mockServerPath = '/server/' + mockServer.port;

        this.app.post(`${mockServerPath}/stop`, async (req, res) => {
            await mockServer.stop();
            this.mockServers = _.reject(this.mockServers, mockServer);

            res.status(200).send(JSON.stringify({
                success: true
            }));
        });
        this.app.use(mockServerPath, bodyParser.json(), graphqlExpress({
            schema: await this.schema,
            rootValue: new StandaloneModel(mockServer)
        }));

        return mockServerPath;
    }

    stop() {
        if (!this.server) return;

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
    root: string
}