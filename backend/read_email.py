"""Read email Lambda - lookup s3Key from DynamoDB, then fetch full email from S3."""
import os
import email
import email.policy
import boto3
from jwt_utils import require_auth, response, CORS_HEADERS

s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ.get('EMAIL_INDEX_TABLE', ''))
BUCKET = os.environ.get('EMAIL_BUCKET', '')


def _extract_body(msg):
    text = html = None
    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            if ct == 'text/plain' and not text:
                text = part.get_content()
            elif ct == 'text/html' and not html:
                html = part.get_content()
    else:
        content = msg.get_content()
        if msg.get_content_type() == 'text/html':
            html = content
        else:
            text = content
    return text or '', html or ''


def handler(event, context):
    if event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 200, 'headers': CORS_HEADERS, 'body': ''}

    err = require_auth(event)
    if err:
        return err

    message_id = (event.get('pathParameters') or {}).get('id', '')
    if not message_id:
        return response(400, {'error': 'Missing email ID'})

    try:
        # Lookup s3Key from DynamoDB
        result = table.get_item(Key={'messageId': message_id})
        item = result.get('Item')
        if not item:
            return response(404, {'error': 'Email not found'})

        s3_key = item['s3Key']
        obj = s3.get_object(Bucket=BUCKET, Key=s3_key)
        raw = obj['Body'].read()
        msg = email.message_from_bytes(raw, policy=email.policy.default)
        text_body, html_body = _extract_body(msg)

        return response(200, {
            'id': message_id,
            'from': item.get('from', ''),
            'to': item.get('to', ''),
            'subject': item.get('subject', ''),
            'date': item.get('date', ''),
            'text': text_body,
            'html': html_body,
        })
    except Exception as e:
        print(f"Read error: {e}")
        return response(500, {'error': 'Failed to read email'})
