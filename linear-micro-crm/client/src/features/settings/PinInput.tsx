// Release 1.2 — OWNED BY U1 sign-in-pin. The PIN field: digits only (typed or pasted), masked, with a show/hide button.
import { forwardRef, useState, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import clsx from 'clsx';
import { PIN_MAX_LENGTH, sanitisePinInput } from '@lm/shared';
import { Input, type InputProps } from '@/components/ui';
import { PIN_COPY } from './pinCopy';

type PinInputBase = Omit<InputProps, 'value' | 'onChange' | 'type' | 'inputMode' | 'maxLength' | 'autoComplete'>;

export interface PinInputProps extends PinInputBase {
  value: string;
  onChange: (value: string) => void;
  /** 'current-password' at sign-in (password managers can fill it), 'new-password' when choosing one. */
  autoComplete?: 'current-password' | 'new-password' | 'off';
}

/**
 * One masked field rather than boxes: it is what password managers fill, pasting works, and phones open the number pad
 * (`inputMode="numeric"`). Anything but digits is dropped and the length stops at six. The eye button is a 40 px target.
 */
export const PinInput = forwardRef<HTMLInputElement, PinInputProps>(function PinInput(
  { value, onChange, autoComplete = 'current-password', size = 'lg', className, disabled, ...rest },
  ref,
) {
  const [visible, setVisible] = useState(false);
  return (
    <span className="relative block">
      <Input
        ref={ref}
        {...rest}
        size={size}
        disabled={disabled}
        type={visible ? 'text' : 'password'}
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete={autoComplete}
        enterKeyHint="go"
        maxLength={PIN_MAX_LENGTH}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        // No placeholder: grey dots in an empty field read as a PIN already typed.
        placeholder=""
        value={value}
        onChange={(e) => onChange(sanitisePinInput(e.target.value))}
        onPaste={(e) => {
          e.preventDefault();
          onChange(sanitisePinInput(e.clipboardData.getData('text')));
        }}
        className={clsx('pl-12! pr-12! text-center font-mono text-2xl! tracking-[0.4em] indent-[0.4em] tabular', className)}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        disabled={disabled}
        aria-label={visible ? PIN_COPY.hide : PIN_COPY.show}
        aria-pressed={visible}
        className="focus-ring absolute right-1 top-1/2 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-md text-muted transition-colors hover:text-fg disabled:opacity-50"
      >
        {visible ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
      </button>
    </span>
  );
});

export interface PinFieldProps {
  /** The PinInput's id. */
  htmlFor: string;
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
  className?: string;
}

/**
 * Label, field and one line under it (the error, else the hint). A real `<label for>` beside the field rather than
 * around it, because the field holds a second control (the show/hide button).
 */
export function PinField({ htmlFor, label, hint, error, children, className }: PinFieldProps) {
  return (
    <div className={clsx('block text-sm', className)}>
      <label htmlFor={htmlFor} className="mb-1.5 block font-medium text-fg">{label}</label>
      {children}
      {error ? (
        <span className="mt-1.5 block text-xs font-medium text-danger" role="alert">{error}</span>
      ) : hint ? (
        <span className="mt-1.5 block text-xs text-muted">{hint}</span>
      ) : null}
    </div>
  );
}
