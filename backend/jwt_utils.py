"""Shared JWT utilities using HMAC-SHA256 (zero dependencies besides boto3)."""
import hashlib
import hmac
import json
import base64
import time
import os

JWT_EXPIRY = int(os.environ.get('JWT_EXPIRY', '3600'))
WEBMAIL_ORIGIN = os.environ.get('WEBMAIL_ORIGIN', '*')

_secrets = {}

def _get_secret(name):
    if name not in _secrets:
        import boto3
        _secrets[name] = boto3.client('secretsmanager').get_secret_value(SecretId=name)['SecretString']
    return _secrets[name]

def _jwt_secret():
    return _get_secret('/webmail/jwt-secret')

def _auth_secret():
    return _get_secret('/webmail/auth-secret')

CORS_HEADERS = {
    'Access-Control-Allow-Origin': WEBMAIL_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Type': 'application/json',
}


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def _b64url_decode(s: str) -> bytes:
    s += '=' * (4 - len(s) % 4)
    return base64.urlsafe_b64decode(s)


def create_jwt(subject: str = 'webmail') -> str:
    header = _b64url(json.dumps({'alg': 'HS256', 'typ': 'JWT'}).encode())
    payload = _b64url(json.dumps({
        'sub': subject,
        'iss': 'webmail.pfeiffer.rocks',
        'aud': 'webmail-api',
        'iat': int(time.time()),
        'exp': int(time.time()) + JWT_EXPIRY,
    }).encode())
    sig = _b64url(hmac.new(_jwt_secret().encode(), f'{header}.{payload}'.encode(), hashlib.sha256).digest())
    return f'{header}.{payload}.{sig}'


def verify_jwt(token: str) -> dict | None:
    """Returns payload dict if valid, None otherwise."""
    try:
        header, payload, sig = token.split('.')
        expected = _b64url(hmac.new(_jwt_secret().encode(), f'{header}.{payload}'.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected):
            return None
        data = json.loads(_b64url_decode(payload))
        if data.get('exp', 0) < time.time():
            return None
        if data.get('iss') != 'webmail.pfeiffer.rocks':
            return None
        if data.get('aud') != 'webmail-api':
            return None
        return data
    except Exception:
        return None


def require_auth(event) -> dict | None:
    """Extract and verify JWT from Authorization header. Returns error response or None if OK."""
    auth = (event.get('headers') or {}).get('Authorization') or (event.get('headers') or {}).get('authorization') or ''
    token = auth.replace('Bearer ', '') if auth.startswith('Bearer ') else ''
    if not token or not verify_jwt(token):
        return response(401, {'error': 'Unauthorized'})
    return None


def response(status: int, body: dict) -> dict:
    return {
        'statusCode': status,
        'headers': CORS_HEADERS,
        'body': json.dumps(body),
    }
