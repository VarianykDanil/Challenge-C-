/**
 * Release 1.4 — OWNED BY F payments-foundation: the four ways to pay as F ships them — their info and abilities (the
 * shared PAYMENT_PROVIDERS entry), their connection forms (configFields) and `ready: false`. Connections can be saved
 * (validateConfig checks the form); testing a connection and paying answer 501 with a plain sentence until package P
 * (bank_file) and package A (revolut, wise, truelayer) put their adapters in ./registry.ts in place of these.
 * P and A may change a stub's configFields here or move them into their adapter file (and correct the abilities in
 * shared/src/logic/payments.ts PAYMENT_PROVIDERS).
 */
import { paymentProviderInfo, type PaymentConfigField, type PaymentProviderId, type PaymentProviderInfo } from '@lm/shared';
import { HttpError } from '../errors.ts';
import { validateConfigFields, type PaymentProviderAdapter } from './provider.ts';

/** 501: this version cannot pay (or test) through the provider yet. */
export function notReadyError(name: string): HttpError {
  return new HttpError(
    501,
    `Paying through ${name} is not switched on in this version of Linear Hub yet. Your connection details are saved; until then, pay these people another way and mark their runs paid in Finance → Runs to pay.`,
    { code: 'provider_not_ready' },
  );
}

/** The connection form of each of the four ways to pay (help: where to find each value, in plain words). */
export const PROVIDER_CONFIG_FIELDS: Record<PaymentProviderId, readonly PaymentConfigField[]> = {
  bank_file: [
    {
      name: 'format',
      label: 'File format',
      type: 'select',
      required: true,
      options: [{ value: 'generic', label: 'General Faster Payments file (CSV)' }],
      help: 'The file your bank’s bulk payment upload takes. If your bank is not in the list, use the general file and check its columns with your bank.',
    },
  ],
  revolut: [
    {
      name: 'clientId',
      label: 'Client ID',
      required: true,
      help: 'In Revolut Business: Settings → APIs → Business API. It is shown once you have added your certificate.',
    },
    {
      name: 'privateKey',
      label: 'Private key',
      secret: true,
      required: true,
      type: 'textarea',
      placeholder: '-----BEGIN PRIVATE KEY-----',
      help: 'The private key you made together with the certificate. Linear Hub stores it encrypted and never shows it again.',
    },
    {
      name: 'accountId',
      label: 'Account to pay from',
      help: 'The ID of your GBP account in Revolut. Leave it empty to choose after you test the connection.',
    },
  ],
  wise: [
    {
      name: 'apiToken',
      label: 'API token',
      secret: true,
      required: true,
      help: 'Make one in your Wise Business settings, under API tokens. Linear Hub stores it encrypted and never shows it again.',
    },
    {
      name: 'profileId',
      label: 'Business profile ID',
      help: 'Leave it empty and Linear Hub uses your business profile.',
    },
  ],
  truelayer: [
    { name: 'clientId', label: 'Client ID', required: true, help: 'In the TrueLayer console, under your app’s settings.' },
    {
      name: 'clientSecret',
      label: 'Client secret',
      secret: true,
      required: true,
      help: 'Shown once in the TrueLayer console when you make it. Linear Hub stores it encrypted and never shows it again.',
    },
    { name: 'signingKeyId', label: 'Signing key ID', required: true, help: 'The key ID TrueLayer shows after you upload your public signing key.' },
    {
      name: 'privateKey',
      label: 'Signing private key',
      secret: true,
      required: true,
      type: 'textarea',
      placeholder: '-----BEGIN EC PRIVATE KEY-----',
      help: 'The private key that goes with that public key. Stored encrypted, never shown again.',
    },
    {
      name: 'merchantAccountId',
      label: 'Merchant account ID',
      help: 'Your GBP merchant account in TrueLayer. Leave it empty to use your only one.',
    },
  ],
};

/** A way to pay that this version cannot use yet (see the header). */
export function stubProvider(id: PaymentProviderId): PaymentProviderAdapter {
  const info = paymentProviderInfo(id) as PaymentProviderInfo;
  const fields = PROVIDER_CONFIG_FIELDS[id];
  return {
    info,
    configFields: fields,
    ready: false,
    validateConfig: (input, existing) => validateConfigFields(fields, input, existing),
    testConnection: async () => {
      throw notReadyError(info.name);
    },
    submit: async () => {
      throw notReadyError(info.name);
    },
    refresh: async () => {
      throw notReadyError(info.name);
    },
  };
}
