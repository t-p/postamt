import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface StorageStackProps extends cdk.StackProps {
  domain: string;
}

export class StorageStack extends cdk.Stack {
  public readonly emailBucket: s3.Bucket;
  public readonly emailIndex: dynamodb.Table;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    const { domain } = props;

    // S3 Bucket for email storage
    this.emailBucket = new s3.Bucket(this, 'EmailStorageBucket', {
      bucketName: `email-storage-${domain.replace('.', '-')}-${this.account}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'ArchiveOldEmails',
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30)
            },
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(90)
            }
          ]
        }
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    // DynamoDB email index
    this.emailIndex = new dynamodb.Table(this, 'EmailIndex', {
      tableName: `email-index-${domain.replace('.', '-')}`,
      partitionKey: { name: 'messageId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.emailIndex.addGlobalSecondaryIndex({
      indexName: 'by-received',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'receivedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Lambda to index new emails into DynamoDB
    const indexEmailFunction = new lambda.Function(this, 'IndexEmailFunction', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index_email.handler',
      code: lambda.Code.fromAsset('./backend'),
      timeout: cdk.Duration.seconds(30),
      environment: {
        EMAIL_INDEX_TABLE: this.emailIndex.tableName,
      },
    });
    this.emailBucket.grantRead(indexEmailFunction);
    this.emailIndex.grantWriteData(indexEmailFunction);

    this.emailBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(indexEmailFunction),
      { prefix: 'incoming/' },
    );
  }
}
