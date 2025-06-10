// These are rough tests for IPs: they exclude valid domain names,
// but they don't strictly check IP formatting (that's fine - invalid
// IPs will fail elsewhere - this is for intended-format checks).
const IPv4_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const IPv6_REGEX = /^(?=.*[0-9a-fA-F])(?=.*:)[0-9a-fA-F:]{2,39}$/;

export const isIPv4Address = (ip: string) =>
    IPv4_REGEX.test(ip);

export const isIPv6Address = (ip: string) =>
    IPv6_REGEX.test(ip);

export const isIP = (ip: string) =>
    isIPv4Address(ip) || isIPv6Address(ip);

// We need to normalize ips some cases (especially comparisons), because the same ip may be reported
// as ::ffff:127.0.0.1 and 127.0.0.1 on the two sides of the connection, for the same ip.
export function normalizeIP(ip: string): string;
export function normalizeIP(ip: string | null | undefined): string | null | undefined;
export function normalizeIP(ip: string | null | undefined): string | null | undefined {
    return (ip && ip.startsWith('::ffff:'))
        ? ip.slice('::ffff:'.length)
        : ip;
}

export const isLocalhostAddress = (host: string | null | undefined) =>
    !!host && ( // Null/undef are something else weird, but not localhost
        host === 'localhost' || // Most common
        host.endsWith('.localhost') ||
        host === '::1' || // IPv6
        normalizeIP(host)!.match(/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/) // 127.0.0.0/8 range
    );