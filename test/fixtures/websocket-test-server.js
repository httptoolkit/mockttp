const WebSocketServer = require('ws').Server;

const wss = new WebSocketServer({ port: 8694 });

wss.on('connection', function connection(ws) {
    ws.on('message', function(message, isBinary) {
        ws.send(message, { binary: isBinary });
    });
});

// Don't let this server block shutdown
wss._server.unref();