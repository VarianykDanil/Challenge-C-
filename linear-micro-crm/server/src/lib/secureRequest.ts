/**
 * Is this request safe to carry money details and secrets? Yes when it arrived over TLS (the built-in HTTPS listener,
 * or https at the trusted proxy: Express sets req.secure from X-Forwarded-Proto only when TRUST_PROXY is set), or when
 * it comes from this very computer (loopback: the office Mac during the trial). Plain http from another device on the
 * Wi-Fi is not: anyone on the same network can read it.
 *
 * Behind a trusted proxy the socket is the proxy itself (often 127.0.0.1), so the client's own address (req.ip, which
 * Express resolves through the trusted hops only) decides whether it is "this computer".
 */
import type { Request } from 'express';

/** 127.0.0.0/8, ::1 and the IPv4-mapped form of 127.x (::ffff:127.0.0.1). */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const a = address.trim().toLowerCase();
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true;
  const v4 = a.startsWith('::ffff:') ? a.slice(7) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

export function isSecureRequest(req: Request): boolean {
  if (req.secure) return true;
  const behindTrustedProxy = Boolean(req.app?.get('trust proxy'));
  return isLoopbackAddress(behindTrustedProxy ? req.ip : req.socket?.remoteAddress);
}
