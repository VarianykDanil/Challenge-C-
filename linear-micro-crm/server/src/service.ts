/**
 * `npm run service:install | service:uninstall | service:status`: run Linear Hub in the background, so phones on the
 * hotspot keep working without a Terminal window open, it starts at log-in and it comes back by itself if it stops.
 *
 *  - macOS: a LaunchAgent, ~/Library/LaunchAgents/uk.co.linear-mcr.hub.plist (KeepAlive + RunAtLoad), logging to
 *    ~/Library/Logs/LinearHub/linear-hub.log, loaded with `launchctl bootstrap gui/<uid>` (or `load -w` on older
 *    macOS).
 *  - Linux: a systemd user unit, ~/.config/systemd/user/linear-hub.service (Restart=always), via `systemctl --user`.
 *  - Windows: prints the Task Scheduler steps.
 *
 * `--print` is a dry run: it prints the file and the commands and changes nothing (`--platform=darwin|linux|win32`
 * shows another platform's file). The service runs this checkout's server/src/index.ts with the Node that ran this
 * command, in production mode, with TZ=Europe/London, plus PORT/HOST/DB_PATH and the other Linear Hub settings that
 * are set in this terminal (paths resolved the way `npm start` resolves them, from server/).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPortHolder, isLinearHub } from './lib/boot.ts';

export const SERVICE_LABEL = 'uk.co.linear-mcr.hub';
export const SYSTEMD_UNIT = 'linear-hub.service';
export type ServicePlatform = 'darwin' | 'linux' | 'win32';

const serverDir = path.resolve(import.meta.dirname, '..');
const repoDir = path.resolve(serverDir, '..');
export const SERVER_ENTRY = path.join(serverDir, 'src', 'index.ts');

export function launchAgentPath(home: string = os.homedir()): string {
  return path.join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

export function macLogPath(home: string = os.homedir()): string {
  return path.join(home, 'Library', 'Logs', 'LinearHub', 'linear-hub.log');
}

export function systemdUnitPath(home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config'), 'systemd', 'user', SYSTEMD_UNIT);
}

/** Where this platform keeps the service file (null on Windows, which has none of ours). */
export function serviceFilePath(platform: string = process.platform): string | null {
  if (platform === 'darwin') return launchAgentPath();
  if (platform === 'linux') return systemdUnitPath();
  return null;
}

/** The installed service file, or null when Linear Hub is not installed as a service on this machine. */
export function installedServiceFile(platform: string = process.platform): string | null {
  const file = serviceFilePath(platform);
  return file && existsSync(file) ? file : null;
}

/** Linear Hub settings handed to the service when they are set in this terminal. */
const PASS_THROUGH = ['PORT', 'HOST', 'DB_PATH', 'LM_APP_SECRET_FILE', 'LM_BACKUP', 'LM_BACKUP_DIR', 'LM_BACKUP_HOUR', 'TRUST_PROXY', 'LM_SMART', 'LM_COMPRESSION'] as const;
const PATH_VARS: ReadonlySet<string> = new Set(['DB_PATH', 'LM_APP_SECRET_FILE', 'LM_BACKUP_DIR']);

/** The service's environment: production, London time, quiet Node, plus the pass-through settings (absolute paths). */
export function serviceEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = { TZ: 'Europe/London', NODE_ENV: 'production', NODE_NO_WARNINGS: '1' };
  for (const key of PASS_THROUGH) {
    const value = env[key]?.trim();
    if (value) out[key] = PATH_VARS.has(key) ? path.resolve(serverDir, value) : value;
  }
  return out;
}

/**
 * The Node binary the service should run: this one, except that a Homebrew Cellar path (removed by the next
 * `brew upgrade node`) is swapped for its stable `opt` link when that link points at the same binary.
 */
export function stableNodePath(execPath: string = process.execPath): string {
  const m = /^(.*)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/.exec(execPath);
  if (m) {
    const opt = path.join(m[1]!, 'opt', m[2]!, 'bin', 'node');
    try {
      if (realpathSync(opt) === realpathSync(execPath)) return opt;
    } catch {
      // no opt link: keep the real path
    }
  }
  return execPath;
}

export interface ServiceSpec {
  node: string;
  entry: string;
  workDir: string;
  env: Record<string, string>;
  log: string;
}

export function serviceSpec(platform: string = process.platform): ServiceSpec {
  return { node: stableNodePath(), entry: SERVER_ENTRY, workDir: serverDir, env: serviceEnvironment(), log: platform === 'darwin' ? macLogPath() : '' };
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unxml = (s: string) => s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** The LaunchAgent property list. */
export function launchAgentPlist(spec: ServiceSpec): string {
  const env = Object.entries(spec.env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Linear Hub, written by npm run service:install (server/src/service.ts). Remove it with npm run service:uninstall. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(spec.node)}</string>
    <string>${xml(spec.entry)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(spec.workDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(spec.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.log)}</string>
</dict>
</plist>
`;
}

/**
 * systemd quoting for Environment=: backslash-escape `\` and `"`, double `%` (specifiers). `$` stays as it is: systemd
 * expands no variables in Environment= ("the $ character has no special meaning", systemd.exec(5)).
 */
const sdQuoteEnv = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
/** systemd quoting for ExecStart=: as above, and `$` doubled, because ExecStart= expands `$VAR` and `${VAR}`. */
const sdQuoteExec = (s: string) => sdQuoteEnv(s).replace(/\$/g, '$$$$');
const sdUnquote = (s: string) => s.replace(/\$\$/g, '$').replace(/%%/g, '%').replace(/\\(.)/g, '$1');

/** The systemd user unit. */
export function systemdUnit(spec: ServiceSpec): string {
  const env = Object.entries(spec.env)
    .map(([k, v]) => `Environment=${sdQuoteEnv(`${k}=${v}`)}`)
    .join('\n');
  return `# Linear Hub, written by npm run service:install (server/src/service.ts). Remove it with npm run service:uninstall.
[Unit]
Description=Linear Hub (Linear MCR)
After=network.target

[Service]
Type=simple
WorkingDirectory=${spec.workDir.replace(/%/g, '%%')}
ExecStart=${sdQuoteExec(spec.node)} ${sdQuoteExec(spec.entry)}
${env}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

/** The Node path a service file runs (first ProgramArguments string, or the first word of ExecStart). */
export function serviceNodePath(content: string): string | null {
  const plist = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(content);
  if (plist) return unxml(plist[1]!);
  const unit = /^ExecStart=(?:"((?:[^"\\]|\\.)*)"|(\S+))/m.exec(content);
  if (unit) return sdUnquote(unit[1] ?? unit[2]!);
  return null;
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Folders macOS privacy protection (TCC) guards per app: a LaunchAgent's node can be refused access inside them. */
const MAC_PROTECTED = [['Desktop'], ['Documents'], ['Downloads'], ['Library', 'Mobile Documents']] as const;

/** The protected folder (`~/Documents`, iCloud Drive's `~/Library/Mobile Documents`, …) that holds `p`, or null. */
export function macProtectedFolder(p: string, home: string = os.homedir()): string | null {
  // as written and with links followed (either may name the folder); lower case because APFS ignores case by default
  const forms = (q: string) => [...new Set([path.resolve(q), real(path.resolve(q))])].map((f) => f.toLowerCase());
  const targets = forms(p);
  for (const parts of MAC_PROTECTED) {
    const root = path.join(home, ...parts);
    if (forms(root).some((r) => targets.some((t) => t === r || t.startsWith(r + path.sep)))) return root;
  }
  return null;
}

/**
 * A warning when the service would read or write inside a folder macOS guards (Desktop, Documents, Downloads, iCloud
 * Drive): a LaunchAgent is not the Terminal, so its node may be refused there ("Operation not permitted" in the log)
 * and the server cannot open the database or write a backup. Null when nothing is in one.
 */
export function macPrivacyWarning(spec: ServiceSpec, home: string = os.homedir()): string | null {
  const places: Array<[string, string | undefined]> = [
    ['this Linear Hub folder', spec.workDir],
    ['the database (DB_PATH)', spec.env.DB_PATH],
    ['the backups folder (LM_BACKUP_DIR)', spec.env.LM_BACKUP_DIR],
    ['the app secret file, the two-step and PIN key (LM_APP_SECRET_FILE)', spec.env.LM_APP_SECRET_FILE],
  ];
  const hits = places.flatMap(([what, p]) => {
    const root = p ? macProtectedFolder(p, home) : null;
    return root ? [`${what} is in ${root.replace(home, '~')}`] : [];
  });
  if (!hits.length) return null;
  return (
    `${hits.join('; ')}. macOS can refuse a background service access to Desktop, Documents, Downloads and iCloud Drive ` +
    '("Operation not permitted" in the log), so the server could not open the database or write backups. Move the ' +
    'Linear Hub folder (and any backups folder) somewhere else in your home folder, for example ~/LinearHub, then run ' +
    `npm run service:install again; or give ${spec.node} Full Disk Access in System Settings › Privacy & Security.`
  );
}

/**
 * A warning when the installed service runs a different Node than this terminal (after an nvm switch or a Node
 * upgrade), or one that no longer exists. Null when there is no service or it matches.
 */
export function staleNodeWarning(file: string | null = installedServiceFile(), execPath: string = process.execPath): string | null {
  if (!file) return null;
  let node: string | null;
  try {
    node = serviceNodePath(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!node) return null;
  if (!existsSync(node)) {
    return `The background service runs Node from ${node}, which no longer exists (an nvm switch or a Node upgrade), so it cannot start. Run  npm run service:install  again.`;
  }
  if (real(node) !== real(execPath)) {
    return `The background service runs Node from ${node}, but this terminal uses ${execPath} (an nvm switch?). Run  npm run service:install  again to move the service to this Node.`;
  }
  return null;
}

// ── command line ─────────────────────────────────────────────────────────────

const port = Number(process.env.PORT ?? 4000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error.message) : ''}`.trim();
  return { ok: r.status === 0 && !r.error, out };
}

const clientBuilt = () => existsSync(path.join(repoDir, 'client', 'dist', 'index.html'));
const PRINT_BUILD_NOTE = '# note: client/dist/index.html is missing; install refuses until you run npm run build';

function requireBuiltClient(): void {
  if (!clientBuilt()) {
    console.error('The built client is missing (client/dist/index.html), so the service would only serve the API. Run npm run build first, then npm run service:install again.');
    process.exit(1);
  }
}

function warnAboutEnvSecret(): void {
  if (!process.env.LM_APP_SECRET) return;
  console.warn(
    'LM_APP_SECRET is set in this terminal, but it is not copied into the service file (it would sit there in plain text). ' +
      'Put the same value in a file readable only by you and set LM_APP_SECRET_FILE to it before installing, or two-step codes and sign-in PINs will not work under the service.',
  );
}

/** Stop a copy started from a terminal with the existing `npm run stop` logic (refuses for a non-Linear Hub holder). */
function stopForegroundCopy(): void {
  const r = spawnSync(process.execPath, [path.join(serverDir, 'src', 'stop.ts')], {
    stdio: 'inherit',
    env: { ...process.env, PORT: String(port), NODE_NO_WARNINGS: '1' },
  });
  if (r.status !== 0) {
    console.error(`Port ${port} could not be freed (see above), so the service was not installed.`);
    process.exit(1);
  }
}

async function waitFor(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return true;
    await sleep(500);
  }
  return check();
}

const answering = () => isLinearHub('127.0.0.1', port, 1000);
const portFree = async () => !(await findPortHolder(port, 300));

function tail(file: string, lines: number): string {
  try {
    const text = readFileSync(file, 'utf8').trimEnd();
    return text.split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log yet)';
  }
}

async function reportStarted(logHint: string): Promise<void> {
  if (await waitFor(answering, 20_000)) {
    console.log(`\nLinear Hub now runs in the background and answers on http://localhost:${port} (npm run share prints the phone address).`);
    console.log('It starts when you log in and comes back by itself within seconds if it stops.');
  } else {
    console.error(`\nThe service is installed but Linear Hub did not answer on port ${port} within 20 s. ${logHint}`);
    process.exitCode = 1;
  }
  console.log(`Logs: ${logHint}`);
  console.log('Check it:  npm run service:status    Stop it for good:  npm run service:uninstall');
  console.log('While it runs as a service, npm run stop only restarts it: use npm run service:uninstall to stop it.');
  console.log('After switching Node (nvm, brew upgrade), run npm run service:install again.');
}

// macOS ──────────────────────────────────────────────────────────────────────

function launchctlTarget(): { domain: string; target: string } {
  const domain = `gui/${process.getuid?.() ?? 501}`;
  return { domain, target: `${domain}/${SERVICE_LABEL}` };
}

async function macInstall(print: boolean): Promise<void> {
  const spec = serviceSpec('darwin');
  const plistPath = launchAgentPath();
  const plist = launchAgentPlist(spec);
  const { domain, target } = launchctlTarget();
  const privacy = macPrivacyWarning(spec);
  if (print) {
    console.log(`# ${plistPath}\n${plist}`);
    console.log(`# then: launchctl bootstrap ${domain} "${plistPath}"   (older macOS: launchctl load -w "${plistPath}")`);
    if (!clientBuilt()) console.log(PRINT_BUILD_NOTE);
    if (privacy) console.log(`# warning: ${privacy}`);
    return;
  }
  requireBuiltClient();
  warnAboutEnvSecret();
  if (privacy) console.warn(`▲ ${privacy}\n`);
  if (run('launchctl', ['print', target]).ok) {
    console.log('Replacing the background service installed earlier…');
    run('launchctl', ['bootout', target]);
    await waitFor(portFree, 10_000);
  }
  stopForegroundCopy();
  mkdirSync(path.dirname(plistPath), { recursive: true });
  mkdirSync(path.dirname(spec.log), { recursive: true });
  writeFileSync(plistPath, plist, { mode: 0o644 });
  run('launchctl', ['enable', target]);
  const boot = run('launchctl', ['bootstrap', domain, plistPath]);
  if (!boot.ok) {
    const load = run('launchctl', ['load', '-w', plistPath]);
    if (!load.ok) {
      console.error(`launchctl could not load ${plistPath}:\n  bootstrap: ${boot.out || 'failed'}\n  load -w: ${load.out || 'failed'}`);
      process.exit(1);
    }
  }
  console.log(`Installed ${SERVICE_LABEL} (${plistPath}), running ${spec.node} ${spec.entry}.`);
  await reportStarted(spec.log);
}

async function macUninstall(print: boolean): Promise<void> {
  const plistPath = launchAgentPath();
  const { target } = launchctlTarget();
  if (print) {
    console.log(`launchctl bootout ${target}   (older macOS: launchctl unload -w "${plistPath}")\nrm "${plistPath}"`);
    return;
  }
  const loaded = run('launchctl', ['print', target]).ok;
  if (!loaded && !existsSync(plistPath)) {
    console.log('Linear Hub is not installed as a background service on this Mac.');
    return;
  }
  if (loaded && !run('launchctl', ['bootout', target]).ok) run('launchctl', ['unload', '-w', plistPath]);
  rmSync(plistPath, { force: true });
  const free = await waitFor(portFree, 10_000);
  console.log(`Removed the background service ${SERVICE_LABEL}.`);
  console.log(free ? `Port ${port} is free. Start it in a terminal with npm start, or install the service again.` : `Port ${port} is still busy: run npm run stop.`);
}

async function macStatus(): Promise<void> {
  const plistPath = launchAgentPath();
  const { target } = launchctlTarget();
  const installed = existsSync(plistPath);
  const p = run('launchctl', ['print', target]);
  console.log(`Service file: ${installed ? plistPath : 'not installed (npm run service:install)'}`);
  if (p.ok) {
    const keep = /^\s*(state|pid|last exit code|runs|program|working directory) = /;
    const lines = p.out.split('\n').filter((l) => keep.test(l)).map((l) => `  ${l.trim()}`);
    console.log(`launchctl: ${SERVICE_LABEL} is loaded\n${lines.join('\n')}`);
  } else {
    console.log(`launchctl: ${SERVICE_LABEL} is not loaded`);
  }
  console.log((await answering()) ? `Answering on http://localhost:${port}` : `Not answering on port ${port}`);
  const stale = staleNodeWarning(installed ? plistPath : null);
  if (stale) console.log(`▲ ${stale}`);
  const privacy = installed ? macPrivacyWarning(serviceSpec('darwin')) : null;
  if (privacy) console.log(`▲ ${privacy}`);
  console.log(`\nLast 20 lines of ${macLogPath()}:\n${tail(macLogPath(), 20)}`);
}

// Linux ──────────────────────────────────────────────────────────────────────

async function linuxInstall(print: boolean): Promise<void> {
  const unitPath = systemdUnitPath();
  const unit = systemdUnit(serviceSpec('linux'));
  if (print) {
    console.log(`# ${unitPath}\n${unit}`);
    console.log(`# then: systemctl --user daemon-reload && systemctl --user enable --now ${SYSTEMD_UNIT}`);
    console.log('# to keep it running while nobody is logged in: loginctl enable-linger $USER');
    if (!clientBuilt()) console.log(PRINT_BUILD_NOTE);
    return;
  }
  requireBuiltClient();
  warnAboutEnvSecret();
  run('systemctl', ['--user', 'stop', SYSTEMD_UNIT]);
  stopForegroundCopy();
  mkdirSync(path.dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, unit, { mode: 0o644 });
  run('systemctl', ['--user', 'daemon-reload']);
  const r = run('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT]);
  if (!r.ok) {
    console.error(`systemctl --user enable --now ${SYSTEMD_UNIT} failed:\n${r.out}\nThe unit is at ${unitPath}. Without a systemd user session (containers, some WSL setups) run Linear Hub with npm start instead.`);
    process.exit(1);
  }
  console.log(`Installed ${SYSTEMD_UNIT} (${unitPath}). To keep it running while nobody is logged in: loginctl enable-linger $USER`);
  await reportStarted(`journalctl --user -u ${SYSTEMD_UNIT} -n 50`);
}

async function linuxUninstall(print: boolean): Promise<void> {
  const unitPath = systemdUnitPath();
  if (print) {
    console.log(`systemctl --user disable --now ${SYSTEMD_UNIT}\nrm "${unitPath}"\nsystemctl --user daemon-reload`);
    return;
  }
  if (!existsSync(unitPath)) {
    console.log('Linear Hub is not installed as a background service on this machine.');
    return;
  }
  run('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
  rmSync(unitPath, { force: true });
  run('systemctl', ['--user', 'daemon-reload']);
  const free = await waitFor(portFree, 10_000);
  console.log(`Removed ${SYSTEMD_UNIT}. ${free ? `Port ${port} is free.` : `Port ${port} is still busy: run npm run stop.`}`);
}

async function linuxStatus(): Promise<void> {
  const unitPath = systemdUnitPath();
  console.log(`Service file: ${existsSync(unitPath) ? unitPath : 'not installed (npm run service:install)'}`);
  const r = run('systemctl', ['--user', 'status', SYSTEMD_UNIT, '--no-pager', '--lines=20']);
  console.log(r.out || '(systemctl gave no answer)');
  console.log((await answering()) ? `Answering on http://localhost:${port}` : `Not answering on port ${port}`);
  const stale = staleNodeWarning(existsSync(unitPath) ? unitPath : null);
  if (stale) console.log(`▲ ${stale}`);
}

// Windows ────────────────────────────────────────────────────────────────────

function windowsSteps(): void {
  const spec = serviceSpec('win32');
  const cmdFile = path.join(serverDir, 'linear-hub-service.cmd');
  const sets = Object.entries(spec.env).map(([k, v]) => `set "${k}=${v}"`);
  console.log(
    [
      'Windows has no service file from Linear Hub; set it up once with Task Scheduler:',
      '',
      `1. Create ${cmdFile} containing:`,
      '     @echo off',
      ...sets.map((s) => `     ${s}`),
      `     cd /d "${spec.workDir}"`,
      // cmd.exe cannot redirect into a folder that does not exist (the task would never start node), so create it
      '     if not exist "%LOCALAPPDATA%\\LinearHub" mkdir "%LOCALAPPDATA%\\LinearHub"',
      `     "${spec.node}" "${spec.entry}" >> "%LOCALAPPDATA%\\LinearHub\\linear-hub.log" 2>&1`,
      '2. Open Task Scheduler > Create Task…',
      '   - General: name it "Linear Hub"; choose "Run only when user is logged on".',
      '   - Triggers: New… > "At log on" (your account).',
      `   - Actions: New… > Start a program > ${cmdFile}`,
      '   - Settings: tick "If the task fails, restart every 1 minute" (up to 999 times) and untick "Stop the task if it runs longer than".',
      '3. Right-click the task > Run, then open http://localhost:' + port,
      '',
      'Or from an administrator prompt:',
      `   schtasks /Create /TN "Linear Hub" /SC ONLOGON /TR "\\"${cmdFile}\\""`,
      'To remove it: schtasks /Delete /TN "Linear Hub" /F',
    ].join('\n'),
  );
}

// main ───────────────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<void> {
  const print = argv.includes('--print');
  const platformFlag = argv.find((a) => a.startsWith('--platform='))?.slice('--platform='.length);
  const command = argv.find((a) => !a.startsWith('--')) ?? (print ? 'install' : undefined);
  if (platformFlag && !print) {
    console.error('--platform only works with --print (a dry run).');
    process.exit(1);
  }
  const platform = (platformFlag ?? process.platform) as string;
  if (!command || !['install', 'uninstall', 'status'].includes(command)) {
    console.log('Usage: npm run service:install | service:uninstall | service:status   (add -- --print for a dry run)');
    process.exit(command ? 1 : 0);
  }
  if (platform === 'win32') return windowsSteps();
  if (platform !== 'darwin' && platform !== 'linux') {
    console.error(`Running as a background service is set up for macOS, Linux and Windows, not ${platform}. Use npm start.`);
    process.exit(1);
  }
  const mac = platform === 'darwin';
  if (command === 'install') await (mac ? macInstall(print) : linuxInstall(print));
  else if (command === 'uninstall') await (mac ? macUninstall(print) : linuxUninstall(print));
  else if (print) console.log(mac ? `launchctl print ${launchctlTarget().target}` : `systemctl --user status ${SYSTEMD_UNIT}`);
  else await (mac ? macStatus() : linuxStatus());
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main(process.argv.slice(2));
