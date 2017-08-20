import fs = require('fs');
import path = require('path');
import express = require('express');
import destroyable, { DestroyableServer } from "../destroyable-server";
import bodyParser = require('body-parser');
import { graphqlExpress, graphiqlExpress } from 'apollo-server-express';
import { buildSchema, GraphQLSchema } from 'graphql';
import { getResolver } from "./standalone-resolver";

export class HttpServerMockStandalone {
    static readonly DEFAULT_PORT = 45456;

    private app: express.Application = express();
    private server: DestroyableServer;

    constructor(private schema: GraphQLSchema) {
        this.app.use('/graphql', bodyParser.json(), graphqlExpress({
            schema,
            rootValue: getResolver()
        }));
        this.app.use('/graphiql', graphiqlExpress({
            endpointURL: '/graphql',
        }));
    }

    start() {
        const port = HttpServerMockStandalone.DEFAULT_PORT;

        return new Promise<void>((resolve, reject) => {
            this.server = destroyable(this.app.listen(port, resolve));
        });
    }

    async stop() {
        await this.server.destroy();
    }
}

function getSchema(filename: string): Promise<GraphQLSchema> {
    return new Promise((resolve, reject) => {
        fs.readFile(path.join(__dirname, filename), 'utf8', (err, schemaString) => {
            if (err) reject(err);
            else resolve(buildSchema(schemaString));
        });
    });
}

export async function getStandalone() {
    const schema = await getSchema('schema.gql')
    return new HttpServerMockStandalone(schema);
}