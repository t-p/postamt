"""List emails Lambda - query DynamoDB index instead of S3."""
import os
import boto3
from jwt_utils import require_auth, response, CORS_HEADERS

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ.get('EMAIL_INDEX_TABLE', ''))


def handler(event, context):
    if event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 200, 'headers': CORS_HEADERS, 'body': ''}

    err = require_auth(event)
    if err:
        return err

    try:
        result = table.query(
            IndexName='by-received',
            KeyConditionExpression='pk = :pk',
            ExpressionAttributeValues={':pk': 'EMAIL'},
            ScanIndexForward=False,
            Limit=50,
        )
        emails = [{
            'id': item['messageId'],
            'from': item.get('from', ''),
            'to': item.get('to', ''),
            'subject': item.get('subject', ''),
            'date': item.get('date', ''),
            'size': int(item.get('size', 0)),
        } for item in result.get('Items', [])]

        return response(200, {'emails': emails})
    except Exception as e:
        print(f"List error: {e}")
        return response(500, {'error': 'Failed to list emails'})
