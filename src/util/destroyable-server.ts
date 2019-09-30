/**
 * @module Internal
 */

import net = require("net");
import http = require("http");

export interface DestroyableServer extends net.Server {
    destroy(): Promise<void>;
}

// Mostly from https://github.com/isaacs/server-destroy (which seems to be unmaintained)
export function destroyable(server: net.Server): DestroyableServer  {
    const connections: { [key: string]: net.Socket } = {};

    server.on('connection', function(conn: net.Socket) {
        const key = conn.remoteAddress + ':' + conn.remotePort;
        connections[key] = conn;
        conn.on('close', function() {
            delete connections[key];
        });
    });

    server.on('secureConnection', function(conn: net.Socket) {
        const key = conn.remoteAddress + ':' + conn.remotePort;
        connections[key] = conn;
        conn.on('close', function() {
            delete connections[key];
        });
    });

    return Object.assign(
        server,
        {
            destroy: () => {
                return new Promise<void>((resolve, reject) => {
                    server.close((err: any) => {
                        if (err) reject(err);
                        else resolve();
                    });

                    for (let key in connections) {
                        connections[key].destroy();
                    }
                });
            }
        }
    );
}
