/**
 * Boot diagnostics: say *why* the process stops, and refuse to start on a port something else already answers on.
 *
 * Background: Express 5's `app.listen(port, cb)` also registers `cb` as the server's 'error' listener, so a failed bind
 * called our callback with the error, we printed "listening", the error counted as handled and the process ended with
 * exit code 0. The entry point now uses node:http directly and the 'error' handler below ends the process loudly.
 *
 * A server that prints "listening" and then silently returns to the shell prompt is impossible to debug from the
 * outside, so every way the process can end is reported here: a signal (which one), a drained event loop (nothing left
 * to keep the server alive), an uncaught error, or an explicit `process.exit` (with the stack of whoever called it).
 *
 * The port probe matters because macOS, unlike Linux, lets `listen()` on the dual-stack wildcard succeed while another
 * process already holds `0.0.0.0:<port>`: the new server reports "listening" but the browser keeps talking to the
 * old one. A TCP connect to both loopback addresses before binding catches that on every OS.
 */
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import net from 'node:net';
import os from 'node:os';

export interface PortHolder {
  /** Loopback address that accepted the probe connection. */
  host: string;
  /** `lsof`/`ss` output for the listener, when the OS could tell us. */
  details: string | null;
  /** True when the listener answered /api/health like this app, or its command line is this server: an earlier copy of Linear Hub. */
  linearHub: boolean;
  /** True when it is a Linear Hub copy that no longer answers HTTP (hung, stopped or paused in a debugger). */
  hung: boolean;
}

/** Try to connect to `host:port`; resolves true if something accepted the connection. */
function accepts(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Which process is listening on the port, as the OS reports it (macOS/Linux `lsof`, Linux `ss`), or null. */
export function describePortHolder(port: number): string | null {
  const attempts: Array<[string, string[]]> =
    process.platform === 'win32'
      ? [['netstat', ['-ano', '-p', 'tcp']]]
      : [
          ['lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']],
          ['ss', ['-Hltnp', `sport = :${port}`]],
        ];
  for (const [cmd, args] of attempts) {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
      const lines = out.split('\n').filter((l) => l.trim());
      const rows =
        cmd === 'netstat'
          ? lines.filter((l) => l.includes(`:${port} `) && /LISTEN/i.test(l))
          : lines.filter((l) => !/^(COMMAND|State)\b/.test(l));
      if (rows.length) return (cmd === 'lsof' ? lines : rows).join('\n');
    } catch {
      // tool missing, or it found nothing: try the next one
    }
  }
  return null;
}

/** Process ids listening on the port, from `lsof`/`ss` output (empty when unknown). */
export function listeningPids(port: number): number[] {
  const details = describePortHolder(port);
  if (!details) return [];
  const pids = new Set<number>();
  for (const line of details.split('\n')) {
    if (/^COMMAND\b/.test(line)) continue;
    const lsof = line.match(/^\S+\s+(\d+)\s/);
    const ss = line.match(/pid=(\d+)/);
    const win = line.match(/\s(\d+)\s*$/);
    const pid = Number(lsof?.[1] ?? ss?.[1] ?? (process.platform === 'win32' ? win?.[1] : undefined));
    if (Number.isFinite(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** The command line of a process (`ps`), or null when it cannot be read. */
export function processCommand(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Does this command line look like a copy of this server (node/tsx running src/index.ts, or anything from this repo)? */
export function looksLikeLinearHub(command: string | null): boolean {
  return !!command && /(^|[\s/])(node|tsx)\b.*\bsrc\/index\.ts\b|linear-micro-crm[\/]server/.test(command);
}

/** Does the process answering on host:port look like this app (GET /api/health → {ok:true, version})? */
export async function isLinearHub(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}/api/health`;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; version?: string };
    return body?.ok === true && typeof body.version === 'string';
  } catch (err) {
    if (process.env.LM_DEBUG) console.error(`health probe ${host}:${port} failed: ${err instanceof Error ? `${err.message}${err.cause instanceof Error ? ` (${err.cause.message})` : ''}` : String(err)}`);
    return false;
  }
}

/** Something already answers on the port (checked on 127.0.0.1 and ::1), or null when it is free. */
export async function findPortHolder(port: number, timeoutMs = 600): Promise<PortHolder | null> {
  for (const host of ['127.0.0.1', '::1']) {
    if (await accepts(host, port, timeoutMs)) {
      const answers = await isLinearHub(host, port);
      const ours = answers || listeningPids(port).some((pid) => looksLikeLinearHub(processCommand(pid)));
      return { host, details: describePortHolder(port), linearHub: ours, hung: ours && !answers };
    }
  }
  return null;
}

/** The message printed when the port is taken: who has it, how to free it, how to use another port. */
export function portBusyMessage(port: number, holder: PortHolder): string {
  const freeIt =
    process.platform === 'win32'
      ? `  netstat -ano | findstr :${port}      (then: taskkill /PID <pid> /F)`
      : `  lsof -nP -iTCP:${port} -sTCP:LISTEN   (then: kill <PID>)`;
  const who = holder.details ? `Listening right now:\n${holder.details.replace(/^/gm, '  ')}` : 'The OS did not report which process holds it.';
  if (holder.linearHub) {
    return [
      holder.hung
        ? `Port ${port} is held by an earlier copy of Linear Hub that is stuck: it no longer answers requests and may ignore a plain kill.`
        : `Port ${port} is already in use by an earlier copy of Linear Hub that is still running (started from another terminal or window).`,
      `That is why the browser shows a blank or stale page on http://localhost:${port}: it is talking to that old process, not to this one.`,
      who,
      holder.hung ? 'Stop it (npm run stop forces it if needed) and start again:' : 'Stop it and start again:',
      '  npm run stop',
      '  npm start',
      `Or start this one on another port:  PORT=${port + 1} npm start   (then open http://localhost:${port + 1})`,
    ].join('\n');
  }
  return [
    `Port ${port} is already in use: something on ${holder.host}:${port} accepted a connection before this server started.`,
    `That is why the browser shows a blank or stale page on http://localhost:${port}: it is talking to that other process, not to this one.`,
    who,
    'Stop that process, then run npm start again:',
    freeIt,
    `Or start Linear Hub on another port:  PORT=${port + 1} npm start   (then open http://localhost:${port + 1})`,
  ].join('\n');
}

export interface ExitDiagnosticsOptions {
  server: Server;
  /** Graceful shutdown, called once on SIGINT/SIGTERM/SIGHUP. */
  shutdown: (signal: NodeJS.Signals) => void;
  log?: (line: string) => void;
}

/**
 * Report every way the process can end. Returns a function that marks a shutdown as intentional, so a planned stop
 * is not reported as a mystery exit.
 */
export function installExitDiagnostics({ server, shutdown, log = console.error }: ExitDiagnosticsOptions): () => void {
  let intentional = false;
  const markIntentional = () => {
    intentional = true;
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      log(`Received ${signal}: shutting down.`);
      markIntentional();
      shutdown(signal);
    });
  }
  // Ctrl+Z would only suspend the process: it keeps the port, answers nothing and ignores a plain kill, which is
  // exactly the "stuck old copy" that blocks the next npm start. Stop cleanly instead and say so.
  process.on('SIGTSTP', () => {
    log('Ctrl+Z received: Linear Hub stops instead of pausing, so the port stays free. Use Ctrl+C to stop it next time.');
    markIntentional();
    shutdown('SIGTSTP');
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    // Without a listener Node would throw this; with one we must end the process ourselves, or a failed bind
    // leaves nothing alive and the process ends with exit code 0 as if nothing had happened.
    if (err.code === 'EADDRINUSE') {
      const port = Number(err.message.match(/:(\d+)$/)?.[1] ?? NaN);
      log(`Cannot listen: ${err.message}. Another process already has this port, so this server did not start.`);
      if (Number.isFinite(port)) {
        const details = describePortHolder(port);
        if (details) log(`Listening right now:\n${details.replace(/^/gm, '  ')}`);
        log(
          process.platform === 'win32'
            ? `Find it with:  netstat -ano | findstr :${port}   or start on another port:  PORT=${port + 1} npm start`
            : `Find it with:  lsof -nP -iTCP:${port} -sTCP:LISTEN   (then kill <PID>), or start on another port:  PORT=${port + 1} npm start`,
        );
      }
    } else if (err.code === 'EACCES') {
      log(`Cannot listen: permission denied (${err.message}). Ports below 1024 need elevated rights; use PORT=4000 or higher.`);
    } else {
      log(`Server error: ${err.stack ?? err.message}`);
    }
    markIntentional();
    process.exit(1);
  });

  server.on('close', () => {
    if (!intentional) log('The HTTP server closed although no shutdown was requested.');
  });

  process.on('beforeExit', (code) => {
    if (intentional) return;
    const resources = typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : [];
    log(
      `Nothing is keeping the server alive any more (the event loop drained, exit code ${code}). ` +
        `Active resources: ${resources.length ? resources.join(', ') : 'none'}. ` +
        'The listening socket should keep the process alive; if you see this, please report it with your Node version and OS.',
    );
  });

  process.on('exit', (code) => {
    if (intentional) return;
    const where = new Error('exit called here').stack?.split('\n').slice(2, 7).join('\n') ?? '';
    log(`Linear Hub API exiting with code ${code} without a shutdown request.${where ? `\n${where}` : ''}`);
  });

  process.on('uncaughtException', (err) => {
    log(`Crashed on an uncaught exception:\n${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    markIntentional();
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log(`Crashed on an unhandled promise rejection:\n${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
    markIntentional();
    process.exit(1);
  });

  return markIntentional;
}

export interface NetworkUrl {
  /** Interface name (`en0`) or `hostname` for the Bonjour/mDNS name. */
  via: string;
  url: string;
}

/**
 * Addresses other devices on the same Wi-Fi or hotspot can use: every non-internal IPv4 address plus the
 * machine's `.local` name (Bonjour/mDNS, which phones and Macs resolve without knowing the IP).
 */
export function networkUrls(port: number, host?: string): NetworkUrl[] {
  if (host && !['0.0.0.0', '::', ''].includes(host)) return [];
  const urls: NetworkUrl[] = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const a of addresses ?? []) {
      if (a.internal || a.family !== 'IPv4') continue;
      urls.push({ via: name, url: `http://${a.address}:${port}` });
    }
  }
  const hostname = os.hostname();
  if (urls.length && hostname && hostname !== 'localhost') {
    const local = hostname.endsWith('.local') ? hostname : `${hostname}.local`;
    urls.push({ via: 'hostname', url: `http://${local.toLowerCase()}:${port}` });
  }
  return urls;
}

/** Human-readable bound address of a listening server (`http://localhost:4000`). */
export function listeningUrl(server: Server, fallbackPort: number): string {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : fallbackPort;
  return `http://localhost:${port}`;
}
