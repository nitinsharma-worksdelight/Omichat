import { isIP } from 'node:net';

/**
 * A client address as stored: `req.ip` (which applies the TRUST_PROXY setting) in its plain form. An IPv4 address seen
 * through an IPv6 socket (`::ffff:1.2.3.4`) becomes `1.2.3.4`; anything that isn't an IP address gives null.
 */
export function normalizeIp(raw: string | null | undefined): string | null {
  let ip = raw?.trim() ?? '';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1]!;
  return isIP(ip) ? ip.toLowerCase() : null;
}
