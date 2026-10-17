/**
 * `npm run stop`: stop an earlier copy of Linear Hub that is still holding the port (default 4000).
 *
 * Only a process that answers GET /api/health like this app, or whose command line is this server (a hung copy),
 * is stopped; anything else on the port is reported and left alone. SIGTERM first (the server shuts down cleanly),
 * SIGKILL if it is still there after three seconds.
 */
import { describePortHolder, findPortHolder, listeningPids } from './lib/boot.ts';

const port = Number(process.env.PORT ?? 4000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const holder = await findPortHolder(port);
if (!holder) {
  console.log(`Nothing is listening on port ${port}.`);
  process.exit(0);
}
if (!holder.linearHub) {
  console.error(`Port ${port} is held by something that is not Linear Hub, so it was left alone:`);
  console.error((holder.details ?? '(the OS did not report which process)').replace(/^/gm, '  '));
  console.error(`Stop it yourself, or run Linear Hub on another port:  PORT=${port + 1} npm start`);
  process.exit(1);
}
const pids = listeningPids(port);
if (!pids.length) {
  console.error(`An earlier Linear Hub answers on port ${port}, but its process id could not be found (lsof/ss missing?). Find it with:  lsof -nP -iTCP:${port} -sTCP:LISTEN`);
  process.exit(1);
}
if (holder.hung) console.log(`The earlier Linear Hub on port ${port} is stuck (it no longer answers requests); forcing it to stop if it ignores SIGTERM.`);
for (const pid of pids) {
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Sent SIGTERM to the earlier Linear Hub (pid ${pid}) on port ${port}.`);
  } catch (err) {
    console.error(`Could not signal pid ${pid}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
for (let i = 0; i < 6; i++) {
  await sleep(500);
  if (!(await findPortHolder(port, 300))) {
    console.log(`Port ${port} is free. Run:  npm start`);
    process.exit(0);
  }
}
for (const pid of pids) {
  try {
    process.kill(pid, 'SIGKILL');
    console.log(`It did not stop in 3 s; sent SIGKILL to pid ${pid}.`);
  } catch {
    // already gone
  }
}
await sleep(500);
if (await findPortHolder(port, 300)) {
  console.error(`Port ${port} is still busy:\n${(describePortHolder(port) ?? '').replace(/^/gm, '  ')}`);
  process.exit(1);
}
console.log(`Port ${port} is free. Run:  npm start`);
