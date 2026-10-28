/**
 * HTTP requests sent from a chosen local (source) address, so the smoke test (src/smoke.ts) can act as another device.
 * The sign-in and code limiters key on the TCP peer, so "another device" is a connection whose source is 127.0.0.2, not
 * one that merely targets a different loopback address.
 *
 * Linux answers on the whole 127.x range. A Mac has only 127.0.0.1 until the others are added (CI does this on its
 * Mac runners), so a missing address is explained with the command that adds it, not a bare EADDRNOTAVAIL.
 */
import http from 'node:http';
import net from 'node:net';

/** The addresses in `addresses` this computer does not have (it cannot listen on them). */
export async function missingLocalAddresses(addresses: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const address of addresses) {
    const ok = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(0, address, () => probe.close(() => resolve(true)));
    });
    if (!ok) missing.push(address);
  }
  return missing;
}

/** What the smoke test prints when addresses are missing: what they are for, and the command that adds them. */
export function missingAddressesMessage(missing: string[]): string {
  return [
    `The smoke test sends from ${missing.join(' and ')} to act as other devices, and this computer does not have ${missing.length === 1 ? 'that address' : 'those addresses'}.`,
    'Linux has them already. On a Mac, add them (until the next restart) with:',
    `  ${missing.map((a) => `sudo ifconfig lo0 alias ${a} up`).join(' && ')}`,
    'then run npm run smoke again.',
  ].join('\n');
}

/** The error for a source address this computer does not have; any other error is passed on unchanged. */
function explainMissingAddress(err: unknown, localAddress: string): unknown {
  if ((err as NodeJS.ErrnoException | null)?.code !== 'EADDRNOTAVAIL') return err;
  return new Error(
    `Cannot send from ${localAddress}: this computer does not have that address. The smoke test uses it as another device. ` +
      `On a Mac, add it (until the next restart) with: sudo ifconfig lo0 alias ${localAddress} up`,
    { cause: err },
  );
}

export function requestVia(localAddress: string, method: string, url: string, headers: Record<string, string>, body?: string): Promise<{ status: number; headers: Headers; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: Number(u.port), path: u.pathname + u.search, method, headers, localAddress }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (data += chunk));
      res.on('end', () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) h.append(k, x);
        resolve({ status: res.statusCode ?? 0, headers: h, text: data });
      });
    });
    req.on('error', (err) => reject(explainMissingAddress(err, localAddress)));
    if (body !== undefined) req.write(body);
    req.end();
  });
}
