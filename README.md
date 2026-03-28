# 📬 Email Infrastructure

Self-hosted email infrastructure for a custom domain, built entirely on AWS. Receives email via SES, stores raw RFC822 in S3, indexes metadata in DynamoDB, and serves a lightweight emergency webmail interface — all for under $5/month.

## Architecture

```
                    ┌─────────────────────────────────────────────────┐
                    │                    AWS (eu-west-1)              │
                    │                                                 │
  Incoming Email ──►│  SES ──► S3 (incoming/{messageId})              │
                    │                │                                │
                    │                ▼                                │
                    │          Index Lambda ──► DynamoDB (email-index) │
                    │                                                 │
                    │  CloudFront ──► S3 (static frontend)            │
                    │       │                                         │
  Browser ─────────►│       └──► API Gateway ──► Lambda (Python)      │
                    │                │               │                │
                    │                │          S3 / DynamoDB / SES   │
                    │                │                                │
  IMAP Server ◄────│  S3 (sync via cronjob)                          │
                    └─────────────────────────────────────────────────┘
```

### Components

| Component | Purpose |
|-----------|---------|
| **AWS SES** | Receive and send email, DKIM signing, TLS enforcement |
| **S3** | Raw email storage with lifecycle (→ IA → Glacier) |
| **DynamoDB** | Email metadata index for fast listing by date |
| **Lambda (Python 3.11)** | Auth, list, read, send, and index email functions |
| **API Gateway** | REST API with CORS, rate limiting |
| **CloudFront** | HTTPS frontend with security headers |
| **Route 53** | DNS management, MX records, DKIM CNAMEs |
| **CDK (TypeScript)** | Infrastructure as code, 3 stacks |

## Project Structure

```
├── backend/                    # Python Lambda functions
│   ├── auth.py                 # Token validation, JWT issuance
│   ├── jwt_utils.py            # HMAC-SHA256 JWT (zero dependencies)
│   ├── list_emails.py          # Query DynamoDB index
│   ├── read_email.py           # Fetch + parse RFC822 from S3
│   ├── send_email.py           # Send via SES
│   └── index_email.py          # S3 trigger → DynamoDB indexer
├── frontend/                   # Static webmail UI
│   ├── index.html              # Login, inbox, reader, composer
│   ├── app.js                  # SPA logic, API client
│   └── styles.css              # Responsive CSS (<6KB)
├── infrastructure/             # AWS CDK (TypeScript)
│   ├── bin/infrastructure.ts   # App entry point, stack wiring
│   └── lib/
│       ├── storage-stack.ts    # S3 bucket, DynamoDB table, index Lambda
│       ├── email-stack.ts      # SES, receipt rules, SMTP/sync IAM users
│       └── webmail-stack.ts    # CloudFront, API Gateway, webmail Lambdas
└── infrastructure/scripts/
    ├── show-dns-config.sh      # Display required DNS records
    └── test-email-infrastructure.sh  # Post-deploy validation
```

## Quick Start

### Prerequisites

- AWS CLI configured with appropriate permissions
- Node.js 22+
- Domain hosted in Route 53

### Deploy

```bash
npm install
npm run build

# Set secrets (generate your own)
export JWT_SECRET=$(openssl rand -hex 32)
export AUTH_SECRET=$(openssl rand -hex 16)

# Deploy all stacks
npx cdk deploy --all --require-approval never
```

### Verify

```bash
# Test infrastructure
./infrastructure/scripts/test-email-infrastructure.sh pfeiffer.rocks

# Show DNS config
./infrastructure/scripts/show-dns-config.sh pfeiffer.rocks
```

### Access Webmail

Open `https://webmail.<your-domain>` and log in with your `AUTH_SECRET` value.

## How It Works

### Receiving Email

1. MX record points to SES (`inbound-smtp.eu-west-1.amazonaws.com`)
2. SES stores raw RFC822 email in S3 under `incoming/{messageId}`
3. S3 event triggers the index Lambda
4. Index Lambda parses headers (From, To, Subject, Date) and writes metadata to DynamoDB

### Webmail

1. User authenticates with a shared secret → receives a short-lived JWT (1 hour)
2. Inbox queries DynamoDB GSI sorted by `receivedAt` (no S3 scanning)
3. Reading an email: DynamoDB lookup for S3 key → fetch and parse full RFC822
4. Sending: validated recipient → SES `send_email`

### IMAP Sync

A Kubernetes cronjob on the Pi cluster syncs emails from S3 to a local Dovecot IMAP server every 5 minutes, using ETag-based deduplication.

## Security

- **Authentication**: HMAC-SHA256 JWT with `iss`/`aud` claims, 1-hour expiry
- **XSS Protection**: HTML emails rendered in sandboxed `<iframe>` (no script execution)
- **Rate Limiting**: API Gateway usage plan (5 req/s, burst 10)
- **Security Headers**: CSP, HSTS, X-Frame-Options: DENY, X-Content-Type-Options: nosniff
- **Auto-Logout**: 15-minute inactivity timeout
- **CORS**: Restricted to `https://webmail.<domain>`
- **IAM**: Least-privilege — SES scoped to domain, DynamoDB read-only for webmail
- **Encryption**: S3 server-side encryption, TLS enforced on SES receipt rules
- **Error Handling**: Generic error messages to client, details logged to CloudWatch

## Cost

| Service | Monthly Cost |
|---------|-------------|
| SES (receive + send) | ~$1.00 |
| S3 (storage + lifecycle) | ~$2.00 |
| DynamoDB (on-demand) | ~$0.10 |
| Lambda | ~$0.10 |
| API Gateway | ~$0.20 |
| CloudFront | ~$0.10 |
| Route 53 | ~$0.50 |
| **Total** | **~$4.00** |

## CDK Stacks

| Stack | Resources | Stateful |
|-------|-----------|----------|
| `StorageStack` | S3 email bucket, DynamoDB index, index Lambda | Yes (RETAIN) |
| `EmailStack` | SES identity, receipt rules, SMTP user, sync user | No |
| `WebmailStack` | CloudFront, API Gateway, 4 Lambdas, S3 site bucket | No |

```bash
# Useful CDK commands
npx cdk diff              # Preview changes
npx cdk deploy StorageStack   # Deploy single stack
npx cdk deploy --all      # Deploy everything
npx cdk destroy WebmailStack  # Tear down (stateful resources retained)
```

## DNS Records (Auto-Configured)

| Type | Name | Value |
|------|------|-------|
| MX | `<domain>` | `10 inbound-smtp.eu-west-1.amazonaws.com` |
| TXT | `<domain>` | `v=spf1 include:amazonses.com ~all` |
| CNAME | `<token>._domainkey.<domain>` | DKIM (3 records, AWS-managed) |
| A | `webmail.<domain>` | CloudFront distribution (alias) |

## License

MIT
