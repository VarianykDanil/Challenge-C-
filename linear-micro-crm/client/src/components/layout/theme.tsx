// Theme store — owned by the Product Designer.
// Persists 'lm-theme' ('light' | 'dark' | 'system'), toggles `.dark` on <html> and follows the
// OS preference while in 'system'. index.html applies the same rule before first paint.
import { useCallback, useSyncExternalStore } from 'react';
import { Moon, Sun, SunMoon } from 'lucide-react';
import clsx from 'clsx';
import { SegmentedControl } from '../ui/SegmentedControl';

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'lm-theme';
const listeners = new Set<() => void>();
let version = 0;
let current: Theme = readStored();

function readStored(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

function prefersDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === 'system' ? (prefersDark() ? 'dark' : 'light') : theme;
}

function apply(theme: Theme) {
  if (typeof document === 'undefined') return;
  const dark = resolveTheme(theme) === 'dark';
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
}

function emit() {
  version += 1;
  listeners.forEach((l) => l());
}

/** Set and persist the theme. Safe to call outside React. */
export function setTheme(theme: Theme) {
  current = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* storage unavailable (private mode) — theme still applies for this session */
  }
  apply(theme);
  emit();
}

export function getTheme(): Theme {
  return current;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

if (typeof window !== 'undefined') {
  // Keep in sync with the OS while in 'system', and with other tabs.
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (current === 'system') { apply('system'); emit(); }
  });
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) { current = readStored(); apply(current); emit(); }
  });
  apply(current);
}

export interface UseTheme {
  theme: Theme;
  /** What is actually showing right now. */
  resolved: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  /** Flip between light and dark (leaves 'system' behind). */
  toggle: () => void;
}

export function useTheme(): UseTheme {
  useSyncExternalStore(subscribe, () => version, () => 0);
  const toggle = useCallback(() => setTheme(resolveTheme(current) === 'dark' ? 'light' : 'dark'), []);
  return { theme: current, resolved: resolveTheme(current), setTheme, toggle };
}

export interface ThemeToggleProps {
  /** `icon` flips light/dark; `segmented` offers Light / Dark / System. */
  variant?: 'icon' | 'segmented';
  size?: 'sm' | 'md';
  className?: string;
}

export function ThemeToggle({ variant = 'icon', size = 'md', className }: ThemeToggleProps) {
  const { theme, resolved, setTheme: set, toggle } = useTheme();

  if (variant === 'segmented') {
    return (
      <SegmentedControl<Theme>
        aria-label="Appearance"
        size={size === 'sm' ? 'sm' : 'md'}
        value={theme}
        onChange={set}
        className={className}
        options={[
          { value: 'light', label: 'Light', icon: <Sun /> },
          { value: 'dark', label: 'Dark', icon: <Moon /> },
          { value: 'system', label: 'Auto', icon: <SunMoon /> },
        ]}
      />
    );
  }

  const dark = resolved === 'dark';
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Light mode' : 'Dark mode'}
      aria-pressed={dark}
      className={clsx(
        'focus-ring relative inline-flex items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg',
        size === 'sm' ? 'h-8 w-8' : 'h-10 w-10',
        className,
      )}
    >
      <Sun className={clsx('absolute h-[18px] w-[18px] transition-all duration-300', dark ? 'rotate-90 scale-0 opacity-0' : 'rotate-0 scale-100 opacity-100')} aria-hidden />
      <Moon className={clsx('absolute h-[18px] w-[18px] transition-all duration-300', dark ? 'rotate-0 scale-100 opacity-100' : '-rotate-90 scale-0 opacity-0')} aria-hidden />
    </button>
  );
}
