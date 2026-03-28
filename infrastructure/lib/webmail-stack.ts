import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';

export interface WebmailStackProps extends cdk.StackProps {
  domain: string;
}

export class WebmailStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebmailStackProps) {
    super(scope, id, props);

    const { domain } = props;
    const webmailSubdomain = `webmail.${domain}`;
    const emailBucketName = `email-storage-${domain.replace('.', '-')}-${this.account}`;

    // Route 53 hosted zone (needed for DNS validation and alias record)
    const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName: domain,
    });

    // SSL Certificate for CloudFront (must be in us-east-1)
    const certificate = new acm.DnsValidatedCertificate(this, 'WebmailCertificate', {
      domainName: webmailSubdomain,
      hostedZone: hostedZone,
      region: 'us-east-1',
    });

    // CloudFront OAI for private S3 access
    const oai = new cloudfront.OriginAccessIdentity(this, 'WebmailOAI');

    // Webmail site bucket (in this stack to avoid cross-stack cyclic deps)
    const siteBucket = new s3.Bucket(this, 'WebmailSiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    siteBucket.grantRead(oai);

    // Security headers
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: `default-src 'self'; connect-src 'self' https://*.execute-api.eu-west-1.amazonaws.com; frame-src 'self' blob:; style-src 'self' 'unsafe-inline'`,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        strictTransportSecurity: { accessControlMaxAge: cdk.Duration.days(365), includeSubdomains: true, override: true },
      },
    });

    // CloudFront Distribution
    const distribution = new cloudfront.Distribution(this, 'WebmailDistribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(siteBucket, { originAccessIdentity: oai }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
      },
      domainNames: [webmailSubdomain],
      certificate: certificate,
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
      ],
    });

    // Shared Lambda environment variables
    const lambdaEnv = {
      EMAIL_BUCKET: emailBucketName,
      EMAIL_INDEX_TABLE: `email-index-${domain.replace('.', '-')}`,
      FROM_ADDRESS: `thomas@${domain}`,
      WEBMAIL_ORIGIN: `https://${webmailSubdomain}`,
    };

    // Lambda execution role with S3 and SES permissions
    const lambdaRole = new iam.Role(this, 'WebmailLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        WebmailPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['s3:GetObject', 's3:ListBucket'],
              resources: [
                `arn:aws:s3:::${emailBucketName}`,
                `arn:aws:s3:::${emailBucketName}/*`,
              ],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['ses:SendEmail', 'ses:SendRawEmail'],
              resources: [`arn:aws:ses:${this.region}:${this.account}:identity/${domain}`],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['dynamodb:GetItem', 'dynamodb:Query'],
              resources: [
                `arn:aws:dynamodb:${this.region}:${this.account}:table/email-index-${domain.replace('.', '-')}`,
                `arn:aws:dynamodb:${this.region}:${this.account}:table/email-index-${domain.replace('.', '-')}/index/*`,
              ],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['secretsmanager:GetSecretValue'],
              resources: [
                `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/webmail/*`,
              ],
            }),
          ],
        }),
      },
    });

    const backendCode = lambda.Code.fromAsset('./backend');

    const authFunction = new lambda.Function(this, 'AuthFunction', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'auth.handler',
      role: lambdaRole,
      code: backendCode,
      environment: lambdaEnv,
      timeout: cdk.Duration.seconds(10),
    });

    const listEmailsFunction = new lambda.Function(this, 'ListEmailsFunction', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'list_emails.handler',
      role: lambdaRole,
      code: backendCode,
      environment: lambdaEnv,
      timeout: cdk.Duration.seconds(30),
    });

    const readEmailFunction = new lambda.Function(this, 'ReadEmailFunction', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'read_email.handler',
      role: lambdaRole,
      code: backendCode,
      environment: lambdaEnv,
      timeout: cdk.Duration.seconds(30),
    });

    const sendEmailFunction = new lambda.Function(this, 'SendEmailFunction', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'send_email.handler',
      role: lambdaRole,
      code: backendCode,
      environment: lambdaEnv,
      timeout: cdk.Duration.seconds(10),
    });

    // API Gateway
    const api = new apigateway.RestApi(this, 'WebmailApi', {
      restApiName: 'Webmail API',
      description: 'API for webmail backend functions',
      defaultCorsPreflightOptions: {
        allowOrigins: [`https://${webmailSubdomain}`],
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    const auth = api.root.addResource('auth');
    auth.addMethod('POST', new apigateway.LambdaIntegration(authFunction));

    const emails = api.root.addResource('emails');
    emails.addMethod('GET', new apigateway.LambdaIntegration(listEmailsFunction));
    emails.addMethod('POST', new apigateway.LambdaIntegration(sendEmailFunction));

    const emailById = emails.addResource('{id}');
    emailById.addMethod('GET', new apigateway.LambdaIntegration(readEmailFunction));

    // Rate limiting
    const plan = api.addUsagePlan('WebmailUsagePlan', {
      throttle: { rateLimit: 5, burstLimit: 10 },
    });
    plan.addApiStage({ stage: api.deploymentStage });

    // Route 53 DNS record

    new route53.ARecord(this, 'WebmailAliasRecord', {
      zone: hostedZone,
      recordName: 'webmail',
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    // Deploy frontend files + inject API config
    const apiConfig = `window.WEBMAIL_API_URL="${api.url}";`;
    new s3deploy.BucketDeployment(this, 'WebmailDeployment', {
      sources: [
        s3deploy.Source.asset('./frontend'),
        s3deploy.Source.data('config.js', apiConfig),
      ],
      destinationBucket: siteBucket,
      distribution: distribution,
      distributionPaths: ['/*'],
    });

    // Outputs
    new cdk.CfnOutput(this, 'WebmailUrl', {
      value: `https://${webmailSubdomain}`,
      description: 'Webmail URL',
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway URL',
    });
  }
}
