/**
 * A "secure request": one nobody else on the network can read. True when the request came over TLS (req.secure: the
 * built-in HTTPS listener, or behind TRUST_PROXY with X-Forwarded-Proto https) or from this computer itself (a
 * loopback socket). Money and secret-handling routes refuse other requests, because on plain Wi-Fi anyone nearby can
 * read what is sent.
 */
import type { Request } from 'express';

/** 127.0.0.0/8, ::1 and the IPv4-mapped forms. */
export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  const a = address.startsWith('::ffff:') ? address.slice(7) : address;
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

export function isSecureRequest(req: Request): boolean {
  return Boolean(req.secure) || isLoopbackAddress(req.socket?.remoteAddress);
}
