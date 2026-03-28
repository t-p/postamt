"""Send email Lambda - send via SES."""
import os
import json
import boto3
from jwt_utils import require_auth, response, CORS_HEADERS

ses = boto3.client('ses')
FROM_ADDRESS = os.environ.get('FROM_ADDRESS', '')


def handler(event, context):
    if event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 200, 'headers': CORS_HEADERS, 'body': ''}

    err = require_auth(event)
    if err:
        return err

    try:
        body = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return response(400, {'error': 'Invalid JSON'})

    to = body.get('to', '')
    subject = body.get('subject', '')
    text = body.get('body', '')

    if not all([to, subject, text]):
        return response(400, {'error': 'Missing to, subject, or body'})

    import re
    if not re.match(r'^[^@\s]+@[^@\s]+\.[^@\s]+$', to) or len(to) > 254:
        return response(400, {'error': 'Invalid email address'})

    try:
        ses.send_email(
            Source=FROM_ADDRESS,
            Destination={'ToAddresses': [to]},
            Message={
                'Subject': {'Data': subject, 'Charset': 'UTF-8'},
                'Body': {'Text': {'Data': text, 'Charset': 'UTF-8'}},
            },
        )
        return response(200, {'message': 'Sent'})
    except Exception as e:
        print(f"SES error: {e}")
        return response(500, {'error': 'Failed to send email'})
