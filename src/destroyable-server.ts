import net = require("net");
import http = require("http");

export interface DestroyableServer extends http.Server {
    destroy(callback?: () => void): void;
}

// Mostly from https://github.com/isaacs/server-destroy (which seems to be unmaintained)
export default function destroyable(server: http.Server): DestroyableServer  {
  var connections: { [key: string]: net.Socket } = {};

  server.on('connection', function(conn: net.Socket) {
    var key = conn.remoteAddress + ':' + conn.remotePort;
    connections[key] = conn;
    conn.on('close', function() {
      delete connections[key];
    });
  });

  (<DestroyableServer> server).destroy = function(cb) {
    server.close(cb);
    for (var key in connections) {
      connections[key].destroy();
    }
  };

  return server;
}
