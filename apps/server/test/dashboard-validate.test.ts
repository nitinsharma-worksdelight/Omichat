import { describe, expect, it } from 'vitest';
import { ApiError, errorMessage, fieldErrors, fieldLabel } from '../../dashboard/src/lib/errors';
import { finalizeKey, isEmail, isPhoneLike, isWebsite, todayLocal } from '../../dashboard/src/lib/validate';
import { slugify } from '../../dashboard/src/lib/format';
import { isPhoneLike as serverPhoneLike, isWebsite as serverWebsite } from '../src/modules/bots/config';

/**
 * Q3 — the dashboard's form checks. They live in the dashboard without React or browser APIs, so they're tested here
 * with the rest of the suite, against the server's own rules where both exist.
 */

describe('form checks', () => {
  it('emails', () => {
    expect(isEmail('hello@brightsmile.example.com')).toBe(true);
    expect(isEmail(' ana@example.co ')).toBe(true);
    for (const bad of ['bad-email', 'a@b', 'a@@b.com', 'a b@c.com', '.a@b.com']) expect(isEmail(bad), bad).toBe(false);
  });

  it('websites, the same way as the server', () => {
    const cases: Array<[string, boolean]> = [
      ['https://brightsmile.example.com', true],
      ['brightsmile.example.com', true],
      ['http://example.com/contact?x=1', true],
      ['not a url', false],
      ['localhost', false],
      ['ftp://example.com', false],
      ['https://', false],
    ];
    for (const [value, ok] of cases) {
      expect(isWebsite(value), value).toBe(ok);
      expect(serverWebsite(value), value).toBe(ok);
    }
  });

  it('phone numbers, the same way as the server', () => {
    const cases: Array<[string, boolean]> = [
      ['(416) 555-0123', true],
      ['+1 202 555 0199', true],
      ['416.555.0123 ext. 4', true],
      ['call us', false],
      ['12345', false],
    ];
    for (const [value, ok] of cases) {
      expect(isPhoneLike(value), value).toBe(ok);
      expect(serverPhoneLike(value), value).toBe(ok);
    }
  });

  it("today's date where the user is", () => {
    expect(todayLocal(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });
});

describe('keys', () => {
  it('are saved clean', () => {
    expect(finalizeKey('Bad Key!')).toBe('bad_key');
    expect(finalizeKey('  __QA  budget__ ')).toBe('qa_budget');
    expect(finalizeKey('a _b')).toBe('a_b');
    expect(finalizeKey('!!!')).toBe('');
    expect(finalizeKey(`${'a'.repeat(63)}_b`)).toBe('a'.repeat(63));
  });

  it('keep a trailing underscore only while being typed', () => {
    expect(slugify('bad_')).toBe('bad_');
    expect(finalizeKey(slugify('bad_'))).toBe('bad');
  });
});

describe('server errors in forms', () => {
  const err = new ApiError(400, 'validation_error', 'Request validation failed', [
    { path: 'value', message: "Can't be negative" },
    { path: 'expectedCloseOn', message: 'Enter a valid date' },
  ]);

  it('read in plain words', () => {
    expect(errorMessage(err)).toBe("Value: Can't be negative; Expected close on: Enter a valid date");
    expect(fieldLabel('business.email')).toBe('Email');
    expect(fieldLabel('leadCapture.fields.0.field')).toBe('Field');
    // Other errors keep their own message in front.
    expect(errorMessage(new ApiError(400, 'bad_request', 'Invalid email address', [{ path: 'email', message: 'Enter a valid email address' }]))).toBe(
      'Invalid email address — Email: Enter a valid email address',
    );
  });

  it('can be shown next to their fields', () => {
    expect(fieldErrors(err)).toEqual({ value: "Can't be negative", expectedCloseOn: 'Enter a valid date' });
    const bot = new ApiError(400, 'bad_request', 'Invalid bot configuration', [{ path: 'business.email', message: 'Enter a valid email address' }]);
    expect(fieldErrors(bot, 'business.')).toEqual({ email: 'Enter a valid email address' });
    expect(fieldErrors(new Error('boom'))).toEqual({});
  });
});
