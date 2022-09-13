// Each of these breaks because they use synthetic default imports internally for
// core node packages. Easiest to skip their types entirely:
declare module 'https-proxy-agent';
declare module 'socks-proxy-agent';
declare module 'pac-proxy-agent';