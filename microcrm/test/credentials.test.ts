import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseAccount, peekReference } from '../src/payments/accounts';
import { decryptCredentials, encryptCredentials, parseCredentialsKey } from '../src/payments/credentials';

const KEY = randomBytes(32);

describe('payment account credentials', () => {
  it('round-trips, and never stores the secret in clear', () => {
    const sealed = encryptCredentials(KEY, 'tenant-a', 'PAYSTACK', { secretKey: 'sk_live_abc123' });
    expect(sealed).toMatch(/^v1:/);
    expect(sealed).not.toContain('abc123');
    expect(decryptCredentials(KEY, 'tenant-a', 'PAYSTACK', sealed)).toEqual({ secretKey: 'sk_live_abc123' });
  });

  it('refuses a value moved to another business or provider, a wrong key, or tampering', () => {
    const sealed = encryptCredentials(KEY, 'tenant-a', 'PAYSTACK', { secretKey: 'sk_live_abc123' });
    expect(() => decryptCredentials(KEY, 'tenant-b', 'PAYSTACK', sealed)).toThrow();
    expect(() => decryptCredentials(KEY, 'tenant-a', 'PAYFAST', sealed)).toThrow();
    expect(() => decryptCredentials(randomBytes(32), 'tenant-a', 'PAYSTACK', sealed)).toThrow();
    const raw = Buffer.from(sealed.slice(3), 'base64');
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
    expect(() => decryptCredentials(KEY, 'tenant-a', 'PAYSTACK', `v1:${raw.toString('base64')}`)).toThrow();
  });

  it('accepts only a 32-byte base64 key', () => {
    expect(parseCredentialsKey(KEY.toString('base64'))).toEqual(KEY);
    expect(() => parseCredentialsKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    expect(() => parseCredentialsKey('not a key')).toThrow();
  });

  it('validates each provider and derives test mode', () => {
    expect(parseAccount('PAYSTACK', { secretKey: 'sk_test_x1' }).testMode).toBe(true);
    expect(parseAccount('PAYFAST', { merchantId: '10000100', merchantKey: '46f0cd694581a', passphrase: 'a-long-passphrase', sandbox: false }).testMode).toBe(false);
    expect(() => parseAccount('PAYSTACK', { secretKey: 'pk_live_x1' })).toThrow();
    expect(() => parseAccount('PAYFAST', { merchantId: '10000100', merchantKey: '46f0cd694581a', passphrase: '', sandbox: false })).toThrow(/passphrase/);
    expect(() => parseAccount('PAYSTACK', { secretKey: 'sk_live_x1', extra: 1 })).toThrow();
  });

  it('peeks the claimed reference without trusting it', () => {
    const header = () => undefined;
    const form = { rawBody: Buffer.from('m_payment_id=WAABC&amount_gross=10.00'), contentType: 'application/x-www-form-urlencoded', sourceIp: undefined, header };
    expect(peekReference('PAYFAST', form)).toBe('WAABC');
    const json = { rawBody: Buffer.from('{"event":"charge.success","data":{"reference":"WAXYZ"}}'), contentType: 'application/json', sourceIp: undefined, header };
    expect(peekReference('PAYSTACK', json)).toBe('WAXYZ');
    expect(peekReference('PAYSTACK', { ...json, rawBody: Buffer.from('not json') })).toBeNull();
    expect(peekReference('OZOW', json)).toBeNull();
  });
});
