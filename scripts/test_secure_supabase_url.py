import unittest

from secure_supabase_url import require_secure_supabase_url


class SecureSupabaseUrlTests(unittest.TestCase):
    def test_accepts_remote_https_and_trims_trailing_slashes(self):
        self.assertEqual(
            require_secure_supabase_url('https://project.supabase.co/'),
            'https://project.supabase.co',
        )

    def test_allows_http_only_for_loopback_development(self):
        self.assertEqual(
            require_secure_supabase_url('http://127.0.0.1:54321/'),
            'http://127.0.0.1:54321',
        )
        self.assertEqual(
            require_secure_supabase_url('http://[::1]:54321'),
            'http://[::1]:54321',
        )

    def test_rejects_remote_http_and_unsupported_schemes(self):
        for value in ('http://project.supabase.co', 'ftp://project.supabase.co'):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    require_secure_supabase_url(value)

    def test_rejects_credentials_query_and_fragment(self):
        for value in (
            'https://user:password@project.supabase.co',
            'https://project.supabase.co?token=value',
            'https://project.supabase.co#fragment',
        ):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    require_secure_supabase_url(value)

    def test_rejects_missing_or_invalid_urls(self):
        for value in (None, '', 'not-a-url', 'http://10.0.0.5:54321'):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    require_secure_supabase_url(value)


if __name__ == '__main__':
    unittest.main()
