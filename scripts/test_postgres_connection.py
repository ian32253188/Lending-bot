import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from postgres_connection import postgres_host_tls, require_verified_tls_dsn


class PostgreSQLTlsPolicyTests(unittest.TestCase):
    def test_dsn_overrides_disabled_tls_and_preserves_other_parameters(self):
        value = require_verified_tls_dsn(
            'postgresql://app@db.example.test:5432/lending?sslmode=disable&application_name=trainer'
        )
        self.assertEqual(parse_qs(urlsplit(value).query), {
            'application_name': ['trainer'],
            'sslmode': ['verify-full'],
        })

    def test_dsn_rejects_invalid_or_non_postgres_urls(self):
        for value in ('', 'https://example.test/db', 'postgresql:///missing-host'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                require_verified_tls_dsn(value)

    def test_remote_host_requires_tls_and_compose_alias_needs_explicit_opt_in(self):
        with patch.dict('os.environ', {'LENDING_BOT_ALLOW_PLAINTEXT_COMPOSE_POSTGRES': '0'}):
            self.assertEqual(postgres_host_tls('postgres'), {'sslmode': 'verify-full'})

        self.assertEqual(postgres_host_tls('db.example.test'), {'sslmode': 'verify-full'})
        self.assertEqual(postgres_host_tls('localhost'), {})
        with patch.dict('os.environ', {'LENDING_BOT_ALLOW_PLAINTEXT_COMPOSE_POSTGRES': '1'}):
            self.assertEqual(postgres_host_tls('postgres'), {})
            self.assertEqual(postgres_host_tls('db.example.test'), {'sslmode': 'verify-full'})


if __name__ == '__main__':
    unittest.main()
