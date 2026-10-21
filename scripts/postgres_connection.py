"""PostgreSQL TLS policy shared by standalone research scripts."""
import os
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


LOCAL_POSTGRES_HOSTS = {'localhost', '127.0.0.1', '::1'}
COMPOSE_POSTGRES_HOST = 'postgres'
ALLOW_PLAINTEXT_COMPOSE_POSTGRES = 'LENDING_BOT_ALLOW_PLAINTEXT_COMPOSE_POSTGRES'


def require_verified_tls_dsn(dsn):
    """Return a PostgreSQL URL with TLS and hostname verification enforced."""
    if not isinstance(dsn, str) or not dsn.strip():
        raise ValueError('DATABASE_URL 必須是有效的 PostgreSQL 連線網址')
    try:
        parsed = urlsplit(dsn)
    except ValueError as exc:
        raise ValueError('DATABASE_URL 必須是有效的 PostgreSQL 連線網址') from exc
    if parsed.scheme not in ('postgres', 'postgresql') or not parsed.hostname:
        raise ValueError('DATABASE_URL 必須使用有效的 PostgreSQL 網址')

    query = [(key, value) for key, value in parse_qsl(parsed.query, keep_blank_values=True)
             if key.lower() != 'sslmode']
    query.append(('sslmode', 'verify-full'))
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), parsed.fragment))


def postgres_host_tls(host):
    """Require verified TLS unless loopback or the private Compose opt-in applies."""
    normalized = str(host or '').strip().lower().strip('[]')
    if normalized in LOCAL_POSTGRES_HOSTS:
        return {}
    if normalized == COMPOSE_POSTGRES_HOST and os.environ.get(ALLOW_PLAINTEXT_COMPOSE_POSTGRES) == '1':
        return {}
    return {'sslmode': 'verify-full'}
