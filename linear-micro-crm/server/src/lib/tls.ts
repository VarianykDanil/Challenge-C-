/**
 * Built-in HTTPS. When LM_TLS_CERT_FILE and LM_TLS_KEY_FILE are both set, the server answers HTTPS on PORT (there is
 * no plain-http port then): cookies become Secure and every answer carries HSTS, because req.secure is true. Set
 * neither to serve plain http (the trial on the office Mac, or behind a reverse proxy such as Caddy, which is the
 * supported way online: docs/DEPLOY.md). Setting only one of them is refused at start-up with a plain message.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface TlsFiles {
  certFile: string;
  keyFile: string;
}

/** Both variables (trimmed) or neither; one without the other throws a sentence for the terminal. */
export function tlsFilesFromEnv(env: NodeJS.ProcessEnv = process.env): TlsFiles | null {
  const cert = env.LM_TLS_CERT_FILE?.trim() ?? '';
  const key = env.LM_TLS_KEY_FILE?.trim() ?? '';
  if (!cert && !key) return null;
  if (!cert || !key) {
    throw new Error(
      'Set both LM_TLS_CERT_FILE and LM_TLS_KEY_FILE for built-in HTTPS (the certificate and its private key, as PEM files), or neither for plain http.',
    );
  }
  return { certFile: cert, keyFile: key };
}

/** The certificate and key, read once at start-up; a missing or unreadable file throws a sentence naming it. */
export function readTlsFiles(files: TlsFiles): { cert: Buffer; key: Buffer } {
  const read = (file: string, what: string): Buffer => {
    try {
      return readFileSync(path.resolve(file));
    } catch (err) {
      throw new Error(`Could not read the HTTPS ${what} at ${path.resolve(file)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return { cert: read(files.certFile, 'certificate (LM_TLS_CERT_FILE)'), key: read(files.keyFile, 'private key (LM_TLS_KEY_FILE)') };
}

/** "https" when built-in HTTPS is configured, else "http" (for the addresses printed at start-up and by npm run share). */
export function serverScheme(env: NodeJS.ProcessEnv = process.env): 'http' | 'https' {
  try {
    return tlsFilesFromEnv(env) ? 'https' : 'http';
  } catch {
    return 'http';
  }
}
