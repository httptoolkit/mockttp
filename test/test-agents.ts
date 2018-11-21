import * as tls from 'tls';
import * as agent from 'agent-base';

interface HttpsProxyAgentOptions {
    proxyHost: string;
    proxyPort: number;
}

// Very quick rough & ready HTTPS proxy agent. None of the bells
// and whistles of npm's https-proxy-agent, but this one works
// for plain HTTP requests on Node 10.10.0+, which is nice.
export const HackyHttpsProxyAgent = (options: HttpsProxyAgentOptions) =>
    agent((_req: any, opts: any) => {
        const socket = tls.connect({
            host: options.proxyHost,
            port: options.proxyPort,
        });

        return new Promise((resolve, reject) => {
            socket.once('connect', () => {
                socket.write(
                    `CONNECT ${opts.host}:${opts.port} HTTP/1.1\r\n` +
                    `Host: ${opts.host}:${opts.port}\r\n\r\n`
                );
                socket.once('data', (d) => {
                    if (d.toString('utf8').match(/HTTP\/1.1 200 OK/)) {
                        resolve(socket);
                    } else {
                        reject(new Error('Unexpected non-200 CONNECT response'));
                    }
                });
            });
            socket.once('error', (e) => reject(e));
        });
    });