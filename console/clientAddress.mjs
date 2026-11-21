// The address of whoever made a request, for limits kept per client (cliSignIn.mjs's waiting sign-ins).
//
// Behind a reverse proxy every request's socket is the proxy's, so the client is in X-Forwarded-For instead: the
// console's own Caddy (providers/aws/terraform/baseBoxStack.sh.tftpl, providers/local/README.md) and Tailscale's serve
// both reach it from loopback, and Caddy writes the address it saw as the header's last entry, replacing any the client
// sent. The header is the client's own word, though, so it is read only from a proxy this console trusts: loopback by
// default, or the addresses and ranges in WOODSHED_TRUSTED_PROXIES. From anyone else it is ignored, and the socket's
// address is the client's. The header is read from its end, one hop for each trusted proxy in turn, so a chain of them
// (a load balancer, then Caddy) gives the first address none of them is, and whatever the client put first is never read.
//
// Only X-Forwarded-For: Caddy sets it and neither Forwarded nor X-Real-IP, and a header nothing in front of the console
// writes is one a client could.

import net from 'node:net';

const DEFAULT_TRUSTED = ['127.0.0.0/8', '::1/128'];

// An IPv6 address's eight groups as numbers, an IPv4 tail (::ffff:1.2.3.4) as the last two. Only for a valid address.
function v6Groups(ip) {
  let text = ip;
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest = null] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = rest ? rest.split(':') : [];
  const fill = rest === null ? [] : Array(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((g) => parseInt(g, 16));
}

/**
 * An address as rules see it: an IPv4 one in IPv6 clothing, however it is written (::ffff:1.2.3.4, ::ffff:c000:201),
 * is IPv4.
 * @returns {string|null}
 */
export function normalAddress(address) {
  const text = String(address ?? '').trim().toLowerCase();
  if (net.isIPv4(text)) return text;
  if (!net.isIPv6(text)) return null;
  const groups = v6Groups(text);
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
  }
  return text;
}

/**
 * The proxies whose X-Forwarded-For is taken, from WOODSHED_TRUSTED_PROXIES: addresses or CIDR ranges, comma-separated.
 * Unset or empty is loopback alone, `none` is nobody.
 * @returns {{list: net.BlockList, names: string[]}}
 */
export function parseTrustedProxies(value) {
  const text = String(value ?? '').trim();
  const names = !text ? DEFAULT_TRUSTED : text.toLowerCase() === 'none' ? [] : text.split(',').map((s) => s.trim()).filter(Boolean);
  // A list of separators alone would trust nobody without saying so: `none` is how that is said.
  if (text && text.toLowerCase() !== 'none' && !names.length) {
    throw new Error(`WOODSHED_TRUSTED_PROXIES is ${text}, which lists no address: list them comma-separated, or say none`);
  }
  const list = new net.BlockList();
  for (const name of names) {
    const [address, bits, extra] = name.split('/');
    const ip = normalAddress(address);
    const family = ip && net.isIPv4(ip) ? 'ipv4' : 'ipv6';
    const most = family === 'ipv4' ? 32 : 128;
    // A range written as IPv4 in IPv6 (::ffff:192.0.2.0/120) is checked as the IPv4 one it is: its first 96 bits are
    // the mapping, so /120 is /24. Shorter than /96 would take in more than mapped addresses, and is refused.
    const mapped = family === 'ipv4' && !net.isIPv4(String(address).trim()) ? 96 : 0;
    const prefix = bits === undefined ? most : /^\d{1,3}$/.test(bits) ? Number(bits) - mapped : NaN;
    if (!ip || extra !== undefined || !(prefix >= 0 && prefix <= most)) {
      throw new Error(`WOODSHED_TRUSTED_PROXIES has ${name}, which is not an address or a range such as 10.0.0.0/8: list them comma-separated, or say none`);
    }
    list.addSubnet(ip, prefix, family);
  }
  return { list, names };
}

function trusted(proxies, ip) {
  return Boolean(ip) && proxies.list.check(ip, net.isIPv4(ip) ? 'ipv4' : 'ipv6');
}

/**
 * The client's address: the socket's, or, while that is a trusted proxy, the X-Forwarded-For entry it added.
 * @param {{socket?: {remoteAddress?: string}, headers?: object}} req
 * @param {{list: net.BlockList}} proxies  from parseTrustedProxies
 * @returns {string|null}  null only when the socket has no address (a test's stand-in, or one already closed)
 */
export function clientAddress(req, proxies = parseTrustedProxies()) {
  let address = normalAddress(req.socket?.remoteAddress);
  if (!address) return null;
  const header = req.headers?.['x-forwarded-for'];
  // Node joins a header sent twice with ", ", which reads the same as one list. An empty entry is kept, so one at the
  // end stops the walk below as any entry that is no address does.
  const raw = String(Array.isArray(header) ? header.join(',') : header ?? '');
  const hops = raw.trim() ? raw.split(',').map((h) => h.trim()) : [];
  while (trusted(proxies, address) && hops.length) {
    const next = normalAddress(hops.pop());
    // An entry that is no address (`unknown`, one with a port, an empty one): the proxy's own address is the client's,
    // which only puts that request with the proxy's other unreadable ones.
    if (!next) break;
    address = next;
  }
  return address;
}

/**
 * The key a per-client limit counts by. An IPv6 address is the /64 it is in: one home or machine is given a whole /64,
 * and could otherwise take a new address for each request.
 * @returns {string|null}
 */
export function clientKey(address) {
  const ip = normalAddress(address);
  if (!ip || net.isIPv4(ip)) return ip;
  return `${v6Groups(ip).slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}
