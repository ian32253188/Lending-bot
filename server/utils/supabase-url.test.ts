import { describe, expect, it } from 'vitest';

const { requireSecureSupabaseUrl } = require('./supabase-url');

describe('secure Supabase URL validation', () => {
  it('accepts remote HTTPS services', () => {
    expect(requireSecureSupabaseUrl('https://project.supabase.co')).toBe('https://project.supabase.co/');
  });

  it.each([
    'http://localhost:54321',
    'http://127.0.0.1:54321',
    'http://[::1]:54321',
  ])('allows loopback HTTP development URL %s', url => {
    expect(requireSecureSupabaseUrl(url)).toBe(url + '/');
  });

  it.each([
    'http://project.supabase.co',
    'http://203.0.113.10:54321',
    'ftp://project.supabase.co',
    'not-a-url',
    'https://user:password@project.supabase.co',
    'https://project.supabase.co?apikey=synthetic-placeholder',
  ])('rejects unsafe or malformed URL %s', url => {
    expect(() => requireSecureSupabaseUrl(url)).toThrow(/SUPABASE_URL/);
  });
});
