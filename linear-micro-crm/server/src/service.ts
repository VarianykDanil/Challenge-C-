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
 * are set in this terminal, the 1.3 LM_STATEMENTS_JOB/LM_STATEMENTS_DIR/LM_UPLOADS_DIR among them (paths resolved the
 * way `npm start` resolves them, from server/).
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const PASS_THROUGH = [
  'PORT',
  'HOST',
  'DB_PATH',
  'LM_APP_SECRET_FILE',
  'LM_BACKUP',
  'LM_BACKUP_DIR',
  'LM_BACKUP_HOUR',
  'TRUST_PROXY',
  'COOKIE_SECURE',
  'LM_SMART',
  'LM_COMPRESSION',
  'LM_DEMO_ACCOUNTS',
  // release 1.3: the Gmail statement reader's switch, and the statements and uploads folders
  'LM_STATEMENTS_JOB',
  'LM_STATEMENTS_DIR',
  'LM_UPLOADS_DIR',
  // off-site encrypted backups, videos in the backups, and the built-in HTTPS certificate
  'LM_OFFSITE_DIR',
  'LM_BACKUP_PASSPHRASE_FILE',
  'LM_BACKUP_VIDEOS',
  'LM_TLS_CERT_FILE',
  'LM_TLS_KEY_FILE',
] as const;
const PATH_VARS: ReadonlySet<string> = new Set([
  'DB_PATH',
  'LM_APP_SECRET_FILE',
  'LM_BACKUP_DIR',
  'LM_STATEMENTS_DIR',
  'LM_UPLOADS_DIR',
  'LM_OFFSITE_DIR',
  'LM_BACKUP_PASSPHRASE_FILE',
  'LM_TLS_CERT_FILE',
  'LM_TLS_KEY_FILE',
]);

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
  /** systemd: a private file (mode 600) the unit reads its secret settings from (EnvironmentFile=). */
  environmentFile?: string | null;
}

/** Where the service keeps the app key handed over from LM_APP_SECRET: outside the data folder, private to this user. */
export function serviceKeyDir(platform: string = process.platform, home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'LinearHub');
  return path.join(env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config'), 'linear-hub');
}

export interface ServiceSecret {
  /** The private file written at install (mode 600); the unit or LaunchAgent itself never holds the key. */
  file: string;
  content: string;
  /** Settings added to the service's environment (none of them is the key). */
  env: Record<string, string>;
  /** systemd reads the key from this file (EnvironmentFile=); null on macOS (launchd cannot), which uses a key file. */
  environmentFile: string | null;
}

/**
 * macOS: the LaunchAgent reads the key from the private key file. LM_UPLOADS_DIR is pinned to where the uploads are
 * now, because they sit next to the key file by default and would otherwise seem to vanish when the key moves.
 */
function macKeyFileEnv(env: NodeJS.ProcessEnv, home: string): { LM_APP_SECRET_FILE: string; LM_UPLOADS_DIR?: string } {
  const file = path.join(serviceKeyDir('darwin', home, env), 'app-secret');
  if (env.LM_UPLOADS_DIR?.trim()) return { LM_APP_SECRET_FILE: file };
  const dataDir = path.dirname(env.DB_PATH?.trim() ? path.resolve(serverDir, env.DB_PATH.trim()) : path.join(serverDir, 'data', 'linear.sqlite'));
  const oldKeyFile = env.LM_APP_SECRET_FILE?.trim() ? path.resolve(serverDir, env.LM_APP_SECRET_FILE.trim()) : path.join(dataDir, 'app-secret');
  return { LM_APP_SECRET_FILE: file, LM_UPLOADS_DIR: path.join(path.dirname(oldKeyFile), 'uploads') };
}

/** Characters a key may have to travel in a systemd environment file without any quoting surprises. */
const PLAIN_SECRET_RE = /^[A-Za-z0-9._~+/=:@-]+$/;

/**
 * How the service gets LM_APP_SECRET when it is set in this terminal: on Linux a private environment file the unit
 * reads (EnvironmentFile=), on macOS a private key file the LaunchAgent points LM_APP_SECRET_FILE at (with
 * LM_UPLOADS_DIR kept where the uploads are now, since they sit next to the key file by default). Both live outside the
 * data folder, so the backups folder never holds them. Null when LM_APP_SECRET is not set; throws a plain message when
 * the value cannot be handed over safely.
 */
export function serviceSecretPlan(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, home: string = os.homedir()): ServiceSecret | null {
  const value = env.LM_APP_SECRET;
  if (!value) return null;
  if (value !== value.trim()) throw new Error('LM_APP_SECRET starts or ends with a space, so it cannot be handed to the service as it is. Remove the spaces (the key changes with them) or put the key in a file and set LM_APP_SECRET_FILE.');
  const dir = serviceKeyDir(platform, home, env);
  if (platform === 'darwin') {
    const env2 = macKeyFileEnv(env, home);
    return { file: env2.LM_APP_SECRET_FILE, content: `${value}\n`, env: env2, environmentFile: null };
  }
  if (!PLAIN_SECRET_RE.test(value)) {
    throw new Error('LM_APP_SECRET has characters (spaces, quotes, $ or %) that a systemd environment file would change. Put the key in a file readable only by you and set LM_APP_SECRET_FILE to it instead.');
  }
  const file = path.join(dir, 'linear-hub.env');
  return {
    file,
    content: `# Linear Hub: the app key for the background service, written by npm run service:install. Keep this file private (mode 600).\nLM_APP_SECRET=${value}\n`,
    env: {},
    environmentFile: file,
  };
}

/** What an installed unit or LaunchAgent hands the server: its Environment settings and its EnvironmentFile=. */
export interface InstalledSettings {
  env: Record<string, string>;
  environmentFile: string | null;
}

/** Reads the settings back from a LaunchAgent or a systemd unit written by launchAgentPlist / systemdUnit. */
export function readServiceSettings(content: string): InstalledSettings {
  const env: Record<string, string> = {};
  const dict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(content);
  if (dict) {
    for (const m of dict[1]!.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) env[unxml(m[1]!)] = unxml(m[2]!);
    return { env, environmentFile: null };
  }
  let environmentFile: string | null = null;
  for (const line of content.split('\n')) {
    const quoted = /^Environment="((?:[^"\\]|\\.)*)"\s*$/.exec(line);
    const value = quoted ? sdUnquoteEnv(quoted[1]!) : /^Environment=(\S+)\s*$/.exec(line)?.[1];
    if (value) {
      const eq = value.indexOf('=');
      if (eq > 0) env[value.slice(0, eq)] = value.slice(eq + 1);
    }
    const file = /^EnvironmentFile=-?(.+?)\s*$/.exec(line);
    if (file) environmentFile = file[1]!.replace(/%%/g, '%');
  }
  return { env, environmentFile };
}

/** The installed service's settings, or null when no service is installed (or its file cannot be read). */
export function installedServiceSettings(platform: string = process.platform, home: string = os.homedir()): InstalledSettings | null {
  const file = platform === 'darwin' ? launchAgentPath(home) : platform === 'linux' ? systemdUnitPath(home) : null;
  if (!file || !existsSync(file)) return null;
  try {
    return readServiceSettings(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * This terminal's settings, with every Linear Hub setting it leaves unset taken from the installed service. Used by
 * `npm run latest`, so its backup, its stop and the restarted service all use the database, port and folders the
 * service really uses, even from a plain terminal.
 */
export function withInstalledSettings(env: NodeJS.ProcessEnv, installed: InstalledSettings | null): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (!installed) return out;
  for (const key of PASS_THROUGH) {
    if (!env[key]?.trim() && installed.env[key]) out[key] = installed.env[key];
  }
  return out;
}

/** Relative paths in the Linear Hub settings made absolute the way the server reads them (from server/). */
export function absoluteServerPaths(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of PATH_VARS) {
    const value = env[key]?.trim();
    if (value) out[key] = path.resolve(serverDir, value);
  }
  return out;
}

/** One value from a private environment file written by writeServiceSecret (`NAME=value` lines). */
function envFileValue(file: string, name: string): string | null {
  try {
    const line = readFileSync(file, 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim() || null : null;
  } catch {
    return null;
  }
}

/**
 * For the commands run by hand (doctor, backup, restore, key:restore, recovery-sheet): when this terminal does not
 * choose a database itself (no DB_PATH), every Linear Hub setting it leaves unset is taken from the installed
 * background service, and so is the key the service reads from its private environment file. The command then looks
 * at the same database, folders and key as the service. A terminal with its own DB_PATH is taken at its word.
 * Changes `env` and returns the names it took ([] when none).
 */
export function useServiceSettings(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, home: string = os.homedir()): string[] {
  if (env.DB_PATH?.trim()) return [];
  const installed = installedServiceSettings(platform, home);
  if (!installed) return [];
  const merged = withInstalledSettings(env, installed);
  const took = Object.keys(merged).filter((k) => merged[k] !== env[k]);
  Object.assign(env, absoluteServerPaths(merged));
  if (!env.LM_APP_SECRET && !env.LM_APP_SECRET_FILE?.trim() && installed.environmentFile) {
    const secret = envFileValue(installed.environmentFile, 'LM_APP_SECRET');
    if (secret) {
      env.LM_APP_SECRET = secret;
      took.push('its app key');
    }
  }
  return took;
}

export interface ServiceSpecOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** The service installed now (default: read from disk); null ignores it. */
  installed?: InstalledSettings | null;
  /** --fresh: this terminal's settings only (no installed service, no key file from an earlier install). */
  fresh?: boolean;
}

/**
 * The service to write. Settings set in this terminal win; any left unset are kept from the service installed before
 * (`kept` says which), so a rebuild from a plain terminal, as `npm run latest` does, never drops the key hand-over or
 * the off-site settings. When nothing names a key, the private key file written by an earlier install is used again.
 */
export function serviceSpec(platform: string = process.platform, opts: ServiceSpecOptions = {}): ServiceSpec & { kept: string[] } {
  const home = opts.home ?? os.homedir();
  const installed = opts.fresh ? null : opts.installed === undefined ? installedServiceSettings(platform, home) : opts.installed;
  const terminal = opts.env ?? process.env;
  const env = withInstalledSettings(terminal, installed);
  const kept: string[] = PASS_THROUGH.filter((k) => env[k] !== terminal[k]);
  let secret: ServiceSecret | null = null;
  try {
    secret = serviceSecretPlan(env, platform, home);
  } catch {
    secret = null; // install says why and stops before writing anything (installEnvSecret)
  }
  const extra: Record<string, string> = { ...(secret?.env ?? {}) };
  let environmentFile = secret?.environmentFile ?? null;
  if (!secret && platform !== 'win32' && !opts.fresh) {
    const keyFile = path.join(serviceKeyDir(platform, home, env), platform === 'darwin' ? 'app-secret' : 'linear-hub.env');
    const namesAKey = Boolean(env.LM_APP_SECRET_FILE?.trim());
    if (platform === 'linux' && installed?.environmentFile && existsSync(installed.environmentFile)) {
      environmentFile = installed.environmentFile;
      kept.push(`the app key file (${environmentFile})`);
    } else if (!namesAKey && existsSync(keyFile)) {
      // written by an earlier install from LM_APP_SECRET: without it the service could not open the locked data
      if (platform === 'linux') environmentFile = keyFile;
      else Object.assign(extra, macKeyFileEnv(env, home));
      kept.push(`the app key file (${keyFile})`);
    }
  }
  return {
    node: stableNodePath(),
    entry: SERVER_ENTRY,
    workDir: serverDir,
    env: { ...serviceEnvironment(env), ...extra },
    log: platform === 'darwin' ? macLogPath(home) : '',
    environmentFile,
    kept,
  };
}

/** The line install prints about the settings it kept (null when it kept none). */
function keptNote(kept: string[]): string | null {
  if (!kept.length) return null;
  return `Kept from the service installed before (this terminal does not set them): ${kept.join(', ')}. To use only this terminal's settings, run  npm run service:install -- --fresh`;
}

/** With --fresh: a warning when a key file kept for the service is now left out. */
function freshNote(platform: string, home: string = os.homedir()): string | null {
  const keyFile = path.join(serviceKeyDir(platform, home), platform === 'darwin' ? 'app-secret' : 'linear-hub.env');
  if (process.env.LM_APP_SECRET || !existsSync(keyFile)) return null;
  return `▲ --fresh: the app key file ${keyFile} from an earlier install is not used. If the database needs that key, the service will not start: set LM_APP_SECRET or LM_APP_SECRET_FILE, or install again without --fresh.`;
}

/**
 * Writes the service's private key or environment file (mode 600, folder 700). A different file already there is
 * never overwritten: it is kept as <file>.replaced-<time>, because it may hold the only copy of an older key.
 */
export function writeServiceSecret(secret: ServiceSecret, now: Date = new Date()): string | null {
  mkdirSync(path.dirname(secret.file), { recursive: true, mode: 0o700 });
  let kept: string | null = null;
  if (existsSync(secret.file)) {
    if (readFileSync(secret.file, 'utf8') === secret.content) return null;
    kept = `${secret.file}.replaced-${now.toISOString().replace(/[:.]/g, '-')}`;
    renameSync(secret.file, kept);
  }
  const tmp = `${secret.file}.${process.pid}.tmp`;
  writeFileSync(tmp, '', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  writeFileSync(tmp, secret.content);
  renameSync(tmp, secret.file);
  return kept;
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
/** The reverse of sdQuoteEnv (inside the quotes): one pass, so an escaped `\\` before `%%` reads back right. */
const sdUnquoteEnv = (s: string) => s.replace(/\\(.)|%(%)/g, (_m, esc: string | undefined, pct: string | undefined) => esc ?? pct ?? '');

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
${env}${spec.environmentFile ? `\nEnvironmentFile=${spec.environmentFile.replace(/%/g, '%%')}` : ''}
Restart=always
RestartSec=2
# 78: the app key is missing or does not match the database (lib/appKey.ts): restarting cannot fix that
RestartPreventExitStatus=78

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
    ['the statements folder (LM_STATEMENTS_DIR)', spec.env.LM_STATEMENTS_DIR],
    ['the uploads folder, the signature image (LM_UPLOADS_DIR)', spec.env.LM_UPLOADS_DIR],
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

/** The command that stops the installed service without removing it (npm run latest, before it updates). */
export function serviceStopCommand(platform: string = process.platform, uid: number = process.getuid?.() ?? 501): [string, string[]] | null {
  if (platform === 'darwin') return ['launchctl', ['bootout', `gui/${uid}/${SERVICE_LABEL}`]];
  if (platform === 'linux') return ['systemctl', ['--user', 'stop', SYSTEMD_UNIT]];
  return null;
}

/** The command that starts the installed service again as it was (after an update that could not finish). */
export function serviceStartCommand(platform: string = process.platform, uid: number = process.getuid?.() ?? 501, home: string = os.homedir()): [string, string[]] | null {
  if (platform === 'darwin') return ['launchctl', ['bootstrap', `gui/${uid}`, launchAgentPath(home)]];
  if (platform === 'linux') return ['systemctl', ['--user', 'start', SYSTEMD_UNIT]];
  return null;
}

/**
 * Stops the installed background service and waits (up to 15 s) until nothing answers on `servicePort`. True when it
 * is stopped. A LaunchAgent is booted out (KeepAlive would bring a killed one straight back); a systemd unit is stopped.
 */
export async function stopInstalledService(servicePort: number = Number(process.env.PORT ?? 4000)): Promise<boolean> {
  const cmd = serviceStopCommand();
  if (!cmd) return false;
  spawnSync(cmd[0], cmd[1], { encoding: 'utf8' });
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    if (!(await findPortHolder(servicePort, 300))) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return !(await findPortHolder(servicePort, 300));
}

/** Starts the installed service again (its file is unchanged). True when the command worked. */
export function startInstalledService(): boolean {
  const cmd = serviceStartCommand();
  if (!cmd) return false;
  return spawnSync(cmd[0], cmd[1], { encoding: 'utf8' }).status === 0;
}

// ── command line ─────────────────────────────────────────────────────────────

/** The port the service answers on: this terminal's PORT, else the installed service's (set in main). */
let port = Number(process.env.PORT ?? 4000);
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

/**
 * LM_APP_SECRET set in this terminal: hand it to the service through a private file outside the data folder (never
 * the service file itself, which is readable by others). Returns the line to print, or exits with the reason.
 */
function installEnvSecret(platform: string, print: boolean, keyFileSetting?: string): string | null {
  let plan: ServiceSecret | null;
  try {
    plan = serviceSecretPlan(process.env, platform);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (!plan) return checkKeyFileSetting(keyFileSetting);
  if (print) return `# would write ${plan.file} (mode 600) holding LM_APP_SECRET (not shown here)`;
  const kept = writeServiceSecret(plan);
  return (
    `The app key from LM_APP_SECRET is kept for the service in ${plan.file} (mode 600, outside the data folder, so never in the backups).` +
    (kept ? ` The different file that was there is kept as ${kept}.` : '')
  );
}

/** LM_APP_SECRET_FILE set (here or kept from the installed service): say if that file is missing or readable by others. */
function checkKeyFileSetting(setting: string | undefined): string | null {
  const raw = setting?.trim();
  if (!raw) return null;
  const file = path.resolve(serverDir, raw);
  if (!existsSync(file)) return `▲ LM_APP_SECRET_FILE points at ${file}, which does not exist yet: a new database gets a new key there; an existing one will not start without its key.`;
  if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) return `▲ The key file ${file} can be read by others: run  chmod 600 "${file}"`;
  return null;
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

/** Prints what install kept from the service before, or left out with --fresh (as comments in a dry run). */
function printSettingsNotes(spec: { kept: string[] }, platform: string, fresh: boolean, print: boolean): void {
  for (const note of [keptNote(spec.kept), fresh ? freshNote(platform) : null]) {
    if (note) console.log(print ? `# ${note}` : note);
  }
}

async function macInstall(print: boolean, fresh: boolean): Promise<void> {
  const spec = serviceSpec('darwin', { fresh });
  const plistPath = launchAgentPath();
  const plist = launchAgentPlist(spec);
  const { domain, target } = launchctlTarget();
  const privacy = macPrivacyWarning(spec);
  if (print) {
    console.log(`# ${plistPath}\n${plist}`);
    console.log(`# then: launchctl bootstrap ${domain} "${plistPath}"   (older macOS: launchctl load -w "${plistPath}")`);
    const keyNote = installEnvSecret('darwin', true, spec.env.LM_APP_SECRET_FILE);
    if (keyNote) console.log(keyNote.startsWith('#') ? keyNote : `# ${keyNote}`);
    printSettingsNotes(spec, 'darwin', fresh, true);
    if (!clientBuilt()) console.log(PRINT_BUILD_NOTE);
    if (privacy) console.log(`# warning: ${privacy}`);
    return;
  }
  requireBuiltClient();
  const keyNote = installEnvSecret('darwin', false, spec.env.LM_APP_SECRET_FILE);
  if (keyNote) console.log(keyNote);
  printSettingsNotes(spec, 'darwin', fresh, false);
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

async function linuxInstall(print: boolean, fresh: boolean): Promise<void> {
  const unitPath = systemdUnitPath();
  const spec = serviceSpec('linux', { fresh });
  const unit = systemdUnit(spec);
  if (print) {
    console.log(`# ${unitPath}\n${unit}`);
    console.log(`# then: systemctl --user daemon-reload && systemctl --user enable --now ${SYSTEMD_UNIT}`);
    console.log('# to keep it running while nobody is logged in: loginctl enable-linger $USER');
    const keyNote = installEnvSecret('linux', true, spec.env.LM_APP_SECRET_FILE);
    if (keyNote) console.log(keyNote.startsWith('#') ? keyNote : `# ${keyNote}`);
    printSettingsNotes(spec, 'linux', fresh, true);
    if (!clientBuilt()) console.log(PRINT_BUILD_NOTE);
    return;
  }
  requireBuiltClient();
  const keyNote = installEnvSecret('linux', false, spec.env.LM_APP_SECRET_FILE);
  if (keyNote) console.log(keyNote);
  printSettingsNotes(spec, 'linux', fresh, false);
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
  const fresh = argv.includes('--fresh');
  const platformFlag = argv.find((a) => a.startsWith('--platform='))?.slice('--platform='.length);
  const command = argv.find((a) => !a.startsWith('--')) ?? (print ? 'install' : undefined);
  if (platformFlag && !print) {
    console.error('--platform only works with --print (a dry run).');
    process.exit(1);
  }
  const platform = (platformFlag ?? process.platform) as string;
  if (!command || !['install', 'uninstall', 'status'].includes(command)) {
    console.log('Usage: npm run service:install | service:uninstall | service:status   (add -- --print for a dry run, -- --fresh to drop the settings of the service installed before)');
    process.exit(command ? 1 : 0);
  }
  if (platform === 'win32') return windowsSteps();
  if (platform !== 'darwin' && platform !== 'linux') {
    console.error(`Running as a background service is set up for macOS, Linux and Windows, not ${platform}. Use npm start.`);
    process.exit(1);
  }
  const mac = platform === 'darwin';
  port = Number(withInstalledSettings(process.env, fresh ? null : installedServiceSettings(platform)).PORT ?? 4000);
  if (command === 'install') await (mac ? macInstall(print, fresh) : linuxInstall(print, fresh));
  else if (command === 'uninstall') await (mac ? macUninstall(print) : linuxUninstall(print));
  else if (print) console.log(mac ? `launchctl print ${launchctlTarget().target}` : `systemctl --user status ${SYSTEMD_UNIT}`);
  else await (mac ? macStatus() : linuxStatus());
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main(process.argv.slice(2));
