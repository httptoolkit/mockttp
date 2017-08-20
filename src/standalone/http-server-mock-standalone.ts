import fs = require('fs');
import path = require('path');
import express = require('express');
import destroyable, { DestroyableServer } from "../destroyable-server";
import bodyParser = require('body-parser');
import { graphqlExpress } from 'apollo-server-express';
import { buildSchema, GraphQLSchema } from 'graphql';
import HttpServerMockServer from "../http-server-mock-server";
import { StandaloneModel } from "./standalone-model";

export class HttpServerMockStandalone {
    static readonly DEFAULT_PORT = 45456;

    private app: express.Application = express();
    private server: DestroyableServer;

    private schemaLoaded: Promise<void>;
    private mockServer: HttpServerMockServer = new HttpServerMockServer();

    constructor() {
        this.schemaLoaded = this.loadSchema('schema.gql').then((schema) => {
            this.app.use('/graphql', bodyParser.json(), graphqlExpress({
                schema,
                rootValue: new StandaloneModel(this.mockServer)
            }));
        });
    }

    loadSchema(schemaFilename: string): Promise<GraphQLSchema> {
        return new Promise((resolve, reject) => {
            fs.readFile(path.join(__dirname, schemaFilename), 'utf8', (err, schemaString) => {
                if (err) reject(err);
                else resolve(buildSchema(schemaString));
            });
        });
    }

    async start() {
        const port = HttpServerMockStandalone.DEFAULT_PORT;

        // Wait for the mock server & schema before we start the admin server
        await this.mockServer.start();
        await this.schemaLoaded;

        await new Promise<void>((resolve, reject) => {
            this.server = destroyable(this.app.listen(port, resolve));
        });
    }

    stop() {
        return Promise.all([
            this.server.destroy(),
            this.mockServer.stop()
        ]);
    }
}