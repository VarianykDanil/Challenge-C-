// What a number typed into a Stepper means while it is being typed. Pure, tested in stepperValue.test.ts.

export interface TypedValue {
  /** The value to use now, or null while the input is empty, half-typed or out of range. */
  value: number | null;
  /** The typed number is past min or max (shown as an error until the field is left, when it is pulled into range). */
  outOfRange: boolean;
}

export function typedStepperValue(raw: string, min: number, max: number, step: number): TypedValue {
  const text = raw.trim();
  if (text === '' || text === '-') return { value: null, outOfRange: false };
  const n = Number(text);
  if (!Number.isFinite(n)) return { value: null, outOfRange: false };
  if (n < min || n > max) return { value: null, outOfRange: true };
  return { value: Math.min(max, Math.max(min, Math.round(n / step) * step)), outOfRange: false };
}
