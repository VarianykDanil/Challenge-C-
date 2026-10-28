/**
 * `npm run share`: the addresses other devices can use for a running Linear Hub, plus a QR code for the first one so a
 * phone on the same Wi-Fi or hotspot can open it by scanning. Checks that the server is actually up first.
 */
import QRCode from 'qrcode';
import { isLinearHub, networkUrls } from './lib/boot.ts';
import { serverScheme } from './lib/tls.ts';

const port = Number(process.env.PORT ?? 4000);

if (!(await isLinearHub('127.0.0.1', port))) {
  console.error(`Linear Hub is not running on port ${port}. Start it first:  npm start   (then run npm run share in another terminal).`);
  process.exit(1);
}
const scheme = serverScheme();
const urls = networkUrls(port, undefined, scheme);
if (!urls.length) {
  console.log(`Linear Hub is running on ${scheme}://localhost:${port}, but this machine has no network address other devices could use (not connected to Wi-Fi or a hotspot?).`);
  process.exit(0);
}
console.log(`Linear Hub is running. Open it from a phone or laptop on the same Wi-Fi or hotspot at:\n`);
for (const u of urls) console.log(`  ${u.url}   (${u.via === 'hostname' ? 'Bonjour name, works while the IP changes' : `via ${u.via}`})`);
console.log(`\nScan to open ${urls[0]!.url}:\n`);
console.log(await QRCode.toString(urls[0]!.url, { type: 'terminal', small: true }));
console.log('If a phone cannot connect: allow incoming connections for "node" in System Settings > Network > Firewall (macOS asks the first time),');
console.log('make sure both devices are on the same network, and keep this terminal running.');
