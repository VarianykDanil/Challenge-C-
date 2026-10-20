// Release 1.2 — L2 learning-pitch: Memorise progress, kept on this device per person and campaign
// (localStorage 'lm-pitch-memorise:<userId>:<CAMPAIGN>' → { v: 1, known: [card keys] }). Card keys come from the
// line's words (pitchLineKey), so editing one line of the pitch only resets that line. Every storage call is wrapped:
// private browsing or a full disk simply means progress is not kept.
import { useCallback, useEffect, useState } from 'react';

export const memoriseKey = (userId: number, campaignCode: string) => `lm-pitch-memorise:${userId}:${campaignCode.toUpperCase()}`;

interface Stored {
  v: 1;
  known: string[];
}

function read(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return new Set(Array.isArray(parsed.known) ? parsed.known.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

function write(key: string, known: Set<string>): void {
  try {
    if (known.size === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ v: 1, known: [...known] } satisfies Stored));
  } catch {
    /* storage unavailable: progress lives for this visit only */
  }
}

export function useMemoriseProgress(userId: number, campaignCode: string) {
  const key = memoriseKey(userId, campaignCode);
  const [known, setKnown] = useState<Set<string>>(() => read(key));

  useEffect(() => {
    setKnown(read(key));
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) setKnown(read(key));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [key]);

  const mark = useCallback(
    (cardKey: string, isKnown: boolean) => {
      setKnown((prev) => {
        const next = new Set(prev);
        if (isKnown) next.add(cardKey);
        else next.delete(cardKey);
        write(key, next);
        return next;
      });
    },
    [key],
  );

  const reset = useCallback(() => {
    write(key, new Set());
    setKnown(new Set());
  }, [key]);

  return { known, mark, reset };
}
