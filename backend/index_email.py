"""S3 trigger Lambda - indexes new emails into DynamoDB."""
import os
import email
import email.policy
import boto3
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ.get('EMAIL_INDEX_TABLE', ''))


def handler(event, context):
    for record in event.get('Records', []):
        bucket = record['s3']['bucket']['name']
        key = record['s3']['object']['key']
        etag = record['s3']['object'].get('eTag', '')

        if not key.startswith('incoming/') or key == 'incoming/':
            continue

        message_id = key.split('/')[-1]
        if not message_id:
            continue

        # Fetch headers (first 8KB)
        obj = s3.get_object(Bucket=bucket, Key=key, Range='bytes=0-8191')
        raw = obj['Body'].read()
        msg = email.message_from_bytes(raw, policy=email.policy.default)

        date_str = msg.get('Date', '')
        try:
            received_at = parsedate_to_datetime(date_str).astimezone(timezone.utc).isoformat()
        except Exception:
            received_at = datetime.now(timezone.utc).isoformat()

        table.put_item(Item={
            'messageId': message_id,
            'pk': 'EMAIL',
            's3Key': key,
            'etag': etag,
            'from': msg.get('From', ''),
            'to': msg.get('To', ''),
            'subject': msg.get('Subject', '(no subject)'),
            'date': date_str,
            'receivedAt': received_at,
            'size': record['s3']['object'].get('size', 0),
        })
        print(f"Indexed {key} -> {message_id}")
