// The field kit in this browser's localStorage (one key, one person; see fieldKitLogic.ts for what it holds and why).
// Every storage call is wrapped: without storage the app simply needs signal to open, as before.
import type { SalesEventWithMeta, SessionInfo, UserWithTeam } from '@lm/shared';
import { kitUser, parseKit, touchKit, withEvents, withUser, type FieldKit } from './fieldKitLogic';

const KEY = 'lm-field-kit';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function read(): FieldKit | null {
  try {
    return parseKit(storage()?.getItem(KEY) ?? null, Date.now());
  } catch {
    return null;
  }
}

function write(kit: FieldKit): void {
  try {
    storage()?.setItem(KEY, JSON.stringify(kit));
  } catch {
    /* full or blocked: the kit is a convenience */
  }
}

/**
 * After every successful sign-in or session check, with the session details the server sent (when it ends, the
 * inactivity sign-out). Roles that never log offline keep no kit, and any kit left by someone else goes.
 */
export function rememberKitUser(user: UserWithTeam, session: SessionInfo | undefined): void {
  const next = withUser(read(), user, Date.now(), session);
  if (next) write(next);
  else forgetKit();
}

/** The server answered for the signed-in person: the inactivity time starts again. */
export function touchKitNow(): void {
  const kit = read();
  if (kit) write(touchKit(kit, Date.now()));
}

/** After the list of events this person can log against loads. */
export function rememberKitEvents(userId: number, events: SalesEventWithMeta[]): void {
  const kit = read();
  if (kit) write(withEvents(kit, userId, events, Date.now()));
}

/** The person last signed in on this phone, for opening the app with no signal (null when there is none). */
export function offlineUser(): UserWithTeam | null {
  return kitUser(read());
}

/** Events kept for `userId`, newest first (empty when there are none). */
export function kitEvents(userId: number): SalesEventWithMeta[] {
  const kit = read();
  return kit && kit.user.id === userId ? kit.events : [];
}

/** On sign-out, and when the server says the session is over. */
export function forgetKit(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
