// Inputs for the second sign-in factor: the six-digit authenticator code and the `xxxx-xxxx` recovery code.
import { forwardRef } from 'react';
import clsx from 'clsx';
import { Input, type InputProps } from '@/components/ui';

export const CODE_LENGTH = 6;
/** True for exactly six digits. */
export const isCompleteCode = (value: string): boolean => new RegExp(`^\\d{${CODE_LENGTH}}$`).test(value);

/** `xxxx-xxxx`, letters or digits either side of the hyphen. */
export const RECOVERY_CODE_RE = /^[a-z0-9]{4}-[a-z0-9]{4}$/i;
/** Normalise whatever was typed or pasted into the `xxxx-xxxx` shape (lower case, hyphen inserted after four characters). */
export function formatRecoveryCode(raw: string): string {
  const chars = raw.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return chars.length > 4 ? `${chars.slice(0, 4)}-${chars.slice(4)}` : chars;
}

type CodeInputBase = Omit<InputProps, 'value' | 'onChange' | 'type' | 'inputMode' | 'autoComplete' | 'maxLength'>;

export interface OneTimeCodeInputProps extends CodeInputBase {
  value: string;
  onChange: (value: string) => void;
  /** Fires once when the sixth digit lands (typed or pasted) so callers can submit without a click. */
  onComplete?: (code: string) => void;
}

/**
 * Six-digit TOTP input. One field rather than six boxes: it is what password managers and iOS/Android
 * SMS/one-time-code autofill target, and pasting "123 456" from an authenticator app just works.
 */
export const OneTimeCodeInput = forwardRef<HTMLInputElement, OneTimeCodeInputProps>(function OneTimeCodeInput(
  { value, onChange, onComplete, className, size = 'lg', ...rest },
  ref,
) {
  const apply = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, CODE_LENGTH);
    onChange(digits);
    if (digits.length === CODE_LENGTH && digits !== value) onComplete?.(digits);
  };
  return (
    <Input
      ref={ref}
      {...rest}
      size={size}
      type="text"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      enterKeyHint="go"
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      placeholder="••••••"
      value={value}
      onChange={(e) => apply(e.target.value)}
      onPaste={(e) => {
        e.preventDefault();
        apply(e.clipboardData.getData('text'));
      }}
      className={clsx('text-center font-mono text-2xl! tracking-[0.4em] indent-[0.4em] tabular', className)}
    />
  );
});

export interface RecoveryCodeInputProps extends CodeInputBase {
  value: string;
  onChange: (value: string) => void;
}

/** Recovery code input: monospace, auto-hyphenated, never auto-capitalised. */
export const RecoveryCodeInput = forwardRef<HTMLInputElement, RecoveryCodeInputProps>(function RecoveryCodeInput(
  { value, onChange, className, size = 'lg', ...rest },
  ref,
) {
  return (
    <Input
      ref={ref}
      {...rest}
      size={size}
      type="text"
      inputMode="text"
      autoComplete="off"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      enterKeyHint="go"
      placeholder="xxxx-xxxx"
      value={value}
      onChange={(e) => onChange(formatRecoveryCode(e.target.value))}
      onPaste={(e) => {
        e.preventDefault();
        onChange(formatRecoveryCode(e.clipboardData.getData('text')));
      }}
      className={clsx('text-center font-mono tracking-[0.2em]', className)}
    />
  );
});
