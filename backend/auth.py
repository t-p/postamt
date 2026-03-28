"""Auth Lambda - validate shared secret, return JWT."""
import json
import hmac
from jwt_utils import create_jwt, response, CORS_HEADERS, _auth_secret


def handler(event, context):
    if event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 200, 'headers': CORS_HEADERS, 'body': ''}

    try:
        body = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return response(400, {'error': 'Invalid JSON'})

    token = body.get('token', '')
    if not token:
        return response(401, {'error': 'Invalid credentials'})

    if not hmac.compare_digest(token, _auth_secret()):
        return response(401, {'error': 'Invalid credentials'})

    return response(200, {'jwt': create_jwt()})
