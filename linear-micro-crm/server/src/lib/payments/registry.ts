/**
 * Release 1.4 — OWNED BY F payments-foundation: the registry of ways to pay (adapters: ./provider.ts).
 *
 * The four built-in ones, in the order Settings → Payments shows them: bank_file, revolut, wise, truelayer. F registers
 * a stub for each (./stubs.ts: `ready: false`). Package P replaces `stubProvider('bank_file')` below with its adapter;
 * package A replaces the other three. Nothing else changes when they do.
 *
 * Tests register the fake (./fake.ts) with `registerPaymentProvider(createFakeProvider())` and remove it with
 * `unregisterPaymentProvider('fake')`. LM_PAYMENTS_FAKE=1 registers it at start-up too, with a fake bank file
 * ('fake_file'), for trying the screens on a demo (they pay nobody) — never set it on a server people are paid from.
 */
import type { PaymentProviderView } from '@lm/shared';
import { createFakeProvider } from './fake.ts';
import type { PaymentProviderAdapter } from './provider.ts';
import { createRevolutProvider } from './revolut.ts';
import { stubProvider } from './stubs.ts';
import { createTrueLayerProvider } from './truelayer.ts';
import { createWiseProvider } from './wise.ts';

const BUILT_IN: readonly PaymentProviderAdapter[] = [
  stubProvider('bank_file'), // package P: the bank payment file
  createRevolutProvider(), // package A: ./revolut.ts
  createWiseProvider(), // package A: ./wise.ts
  createTrueLayerProvider(), // package A: ./truelayer.ts
];

const adapters = new Map<string, PaymentProviderAdapter>(BUILT_IN.map((a) => [a.info.id, a]));
if (process.env.LM_PAYMENTS_FAKE?.trim() === '1') {
  adapters.set('fake', createFakeProvider());
  adapters.set('fake_file', createFakeProvider({ id: 'fake_file', kind: 'file' }));
}

/** The adapter for a provider id (null for an unknown one). */
export function paymentProvider(id: string): PaymentProviderAdapter | null {
  return adapters.get(id) ?? null;
}

/** Every registered way to pay, built-in ones first. */
export function listPaymentProviders(): PaymentProviderAdapter[] {
  return [...adapters.values()];
}

/** Adds (or replaces) an adapter: tests and the fake. */
export function registerPaymentProvider(adapter: PaymentProviderAdapter): void {
  adapters.set(adapter.info.id, adapter);
}

/** Test hook: removes an adapter that is not built in; a built-in id goes back to its stub. */
export function unregisterPaymentProvider(id: string): void {
  const builtIn = BUILT_IN.find((a) => a.info.id === id);
  if (builtIn) adapters.set(id, builtIn);
  else adapters.delete(id);
}

/** GET /payments/providers: what the page shows for each. */
export function providerView(a: PaymentProviderAdapter): PaymentProviderView {
  return { ...a.info, abilities: { ...a.info.abilities, setup: [...a.info.abilities.setup] }, configFields: a.configFields.map((f) => ({ ...f })), available: a.ready };
}
