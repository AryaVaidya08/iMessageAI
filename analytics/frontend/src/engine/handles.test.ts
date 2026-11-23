import { describe, expect, it } from 'vitest';
import { inferDefaultRegion, normalizeHandle } from './handles';

describe('normalizeHandle', () => {
  it('normalizes US formats', () => {
    for (const r of ['(415) 555-2671', '415-555-2671', '4155552671', '14155552671', '+1 415 555 2671', 'tel:+14155552671'])
      expect(normalizeHandle(r)).toBe('+14155552671');
  });
  it('handles international numbers', () => {
    expect(normalizeHandle('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizeHandle('020 7946 0958', 'GB')).toBe('+442079460958');
    expect(normalizeHandle('+91 98765 43210')).toBe('+919876543210');
    expect(normalizeHandle('0044 20 7946 0958')).toBe('+442079460958');
  });
  it('falls back leniently for fake NANP numbers', () => {
    expect(normalizeHandle('(555) 123-4567')).toBe('+15551234567');
    expect(normalizeHandle('+15551234567')).toBe('+15551234567');
  });
  it('lowercases emails', () => {
    expect(normalizeHandle('  Foo@Bar.COM ')).toBe('foo@bar.com');
    expect(normalizeHandle('mailto:A@b.co')).toBe('a@b.co');
  });
  it('keeps short codes and empties', () => {
    expect(normalizeHandle('12345')).toBe('12345');
    expect(normalizeHandle('')).toBe('');
  });
  it('infers region', () => {
    expect(inferDefaultRegion(['+442079460958', '+442079460959', '+14155552671', 'a@b.c'])).toBe('GB');
    expect(inferDefaultRegion(['a@b.c'])).toBeUndefined();
  });
});
