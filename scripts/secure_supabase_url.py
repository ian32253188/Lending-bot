from ipaddress import ip_address
from urllib.parse import urlsplit


def _is_loopback_hostname(hostname):
    normalized = hostname.lower().strip('[]')
    if normalized == 'localhost':
        return True
    try:
        return ip_address(normalized).is_loopback
    except ValueError:
        return False


def require_secure_supabase_url(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('SUPABASE_URL must be a valid HTTPS URL; HTTP is allowed only for a loopback development server.')

    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        parsed.port  # Validate the port without including URL data in errors.
    except ValueError as error:
        raise ValueError('SUPABASE_URL must be a valid HTTPS URL; HTTP is allowed only for a loopback development server.') from error

    if not hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('SUPABASE_URL must not contain credentials, query parameters, or a fragment.')

    if parsed.scheme == 'https':
        return value.rstrip('/')
    if parsed.scheme == 'http' and _is_loopback_hostname(hostname):
        return value.rstrip('/')

    raise ValueError('SUPABASE_URL must use HTTPS for remote services; HTTP is allowed only for a loopback development server.')
