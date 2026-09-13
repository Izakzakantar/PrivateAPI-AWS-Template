# Private API Gateway Template

An editable architecture diagram is at [`docs/architecture-diagram.drawio`](./docs/architecture-diagram.drawio)
(open it at [diagrams.net](https://app.diagrams.net)). A rendered PNG has
not been generated yet -- see `docs/README.md` for how to export one and
drop it in as `docs/architecture-diagram.png`, then swap this paragraph
for a `![Architecture Diagram](./docs/architecture-diagram.png)` image
embed.

This is a **reference architecture template**, not a deploy-and-forget
solution. It is a starting point for a fully private AWS API: every
project-specific value (names, domain, certificate, table schema, etc.) is
parameterized, but you are expected to read through the stack, understand
each layer, and adapt it before running this against a real workload.

> **Requires CloudFront Business plan ($200/month minimum) for VPC
> Origins.** CloudFront's VPC Origins feature (used to reach the internal
> ALB in this template) is only available on the CloudFront Business or
> higher support plan. If your traffic is low and $200/month is not
> justified, consider the cheaper **shared-secret-header + standard
> CloudFront** pattern instead: keep the API Gateway public but locked
> down with a resource policy that only allows requests carrying a secret
> header that only CloudFront's origin-request policy injects. That
> pattern gets you most of the same protection (nobody can hit the API
> Gateway URL directly without the secret) without the PrivateLink/ALB
> machinery or the Business-plan cost.

## Table of contents

- [Architecture](#architecture)
- [Why a Private API](#why-a-private-api)
- [How PrivateLink Works](#how-privatelink-works)
- [Security model summary](#security-model-summary)
- [Configuration](#configuration)
- [Cost breakdown](#cost-breakdown)
- [Deploying](#deploying)
- [Regions](#regions)

## Architecture

```
Client
  -> Route 53 (optional -- only if hostedZoneId is configured)
  -> CloudFront (WAF attached, alternate domain name, custom origin header)
  -> CloudFront VPC Origin
  -> Internal Application Load Balancer (private subnets, HTTPS listener)
  -> VPC Endpoint for execute-api (AWS PrivateLink)
  -> Private API Gateway (REST API, resource policy scoped to the VPC Endpoint)
  -> Cognito JWT Authorizer (validates the request before it reaches Lambda)
  -> Lambda
  -> DynamoDB
```

Cognito issues the JWTs that clients attach to their requests. API Gateway
validates those tokens with a `CognitoUserPoolsAuthorizer` before a request
is ever allowed to invoke the Lambda function.

## Why a Private API

By default, an API Gateway REST API is reachable at its own public
`execute-api.<region>.amazonaws.com` URL, in addition to whatever domain
you put in front of it. That default URL is not secret -- it can be found
through certificate transparency logs, DNS history, subdomain enumeration
tools, or simple guessing (account ID and API ID are the only unknowns).

That matters because anyone who discovers that URL can call the API
**directly**, completely bypassing CloudFront. That means bypassing:

- WAF rules
- Rate limiting / throttling configured at the edge
- Any caching, header injection, or other edge-level logic
- Whatever assumption you made that "all traffic goes through CloudFront"

A Private API eliminates this class of problem structurally rather than
relying on convention or an easily-guessed secret. Once an API Gateway
REST API's endpoint type is set to `PRIVATE` and it has a resource policy
scoped to a specific VPC Endpoint, the public `execute-api` URL **stops
resolving entirely** for anyone outside the VPC. There is no public
listener left to find, guess, or bypass -- the only path in is through the
VPC Endpoint, which in this template is only reachable from the internal
ALB, which is itself only reachable from CloudFront's origin-facing IP
ranges.

## How PrivateLink Works

This section explains the mechanism behind the "VPC Endpoint" and "bridge"
pieces of the architecture, since they are easy to treat as a black box.

**API Gateway does not live inside your VPC.** Like almost every AWS
service, API Gateway runs in AWS-owned infrastructure outside the network
boundary of any customer VPC. There is no way to "put API Gateway inside
your VPC" -- it is a shared, multi-tenant service sitting on AWS's own
network.

**A VPC Endpoint is what creates a path into that shared service from
inside your VPC.** Specifically, an *interface* VPC Endpoint provisions
Elastic Network Interfaces (ENIs) -- with real private IP addresses --
directly inside the subnets you choose. Those ENIs are the actual "door":
from inside the VPC, traffic sent to one of those private IPs (or to the
endpoint's private DNS name, since `privateDnsEnabled` is turned on here)
enters the PrivateLink connection instead of going out to the internet.

**AWS PrivateLink is the technology that connects those ENIs to the
service's backend.** Once traffic enters through the ENI, PrivateLink
carries it across AWS's internal network backbone straight to API
Gateway's backend fleet. At no point does this traffic traverse the public
internet, and it never needs an internet gateway, NAT gateway, or public
IP address to work.

**Why the internal ALB exists at all: CloudFront cannot target a VPC
Endpoint directly.** CloudFront's VPC Origins feature supports exactly
three origin types: an Application Load Balancer, a Network Load Balancer,
or an EC2 instance. A VPC Endpoint is not on that list and cannot be
selected as a CloudFront origin. The internal ALB in this template exists
solely to bridge that gap: it is a origin type CloudFront *can* address,
and its only job is to forward traffic on to the VPC Endpoint's ENI IP
addresses (the target group is populated dynamically from those IPs; see
`lib/private-api-gateway-template-stack.ts`, section 6, `BRIDGE`).

## Security model summary

Putting the two sections above together, each hop enforces exactly one
thing:

| Hop | Enforcement |
| --- | --- |
| CloudFront -> ALB | ALB security group only allows 443 from the CloudFront managed prefix list (`com.amazonaws.global.cloudfront.origin-facing`) |
| ALB -> VPC Endpoint | VPC Endpoint security group only allows 443 from the ALB's security group |
| VPC Endpoint -> API Gateway | API Gateway resource policy only allows `execute-api:Invoke` when `aws:SourceVpce` matches this specific endpoint |
| Client -> API | Cognito JWT authorizer rejects any request without a valid token before Lambda ever runs |
| Edge | WAF (AWS managed common rule set) attached to the CloudFront distribution |

No single layer is load-bearing on its own -- the point of this template
is that a request has to pass through every layer, and each layer only
trusts the layer immediately before it.

## Configuration

All project-specific values live in `cdk.json` under the
`context.privateApiGateway` key (see `lib/config.ts` for the type
definition and defaults). Override any of them per-deploy with `-c`, e.g.:

```
cdk deploy -c privateApiGateway:domainName=api.mycompany.com
```

| Key | Description | Default / placeholder |
| --- | --- | --- |
| `apiName` | Name given to the API Gateway REST API | `your-api-name` |
| `domainName` | Public domain CloudFront answers for. Must match `certificateArn`. | `api.example.com` |
| `certificateArn` | ACM certificate ARN, used by both CloudFront and the ALB's HTTPS listener. **Must be filled in before deploying** -- see the region note below. | `""` (empty -- TODO) |
| `hostedZoneId` | Route 53 hosted zone ID. If set, an ALIAS record for `domainName` is created automatically. If left empty, no DNS record is created and the CloudFront domain name is emitted as a `CfnOutput` instead, so you can point whatever DNS provider you actually use at it manually. | `""` (empty) |
| `vpcCidr` | CIDR range for the VPC | `10.0.0.0/16` |
| `maxAzs` | Number of Availability Zones (and matching private subnets) | `2` |
| `dynamoTableName` | DynamoDB table name | `your-table-name` |
| `partitionKeyName` | DynamoDB partition key attribute name | `userId` |
| `sortKeyName` | DynamoDB sort key attribute name | `itemId` |
| `lambdaFunctionName` | Name given to the backing Lambda function | `your-function-name` |
| `cognitoUserPoolName` | Name given to the Cognito User Pool | `your-user-pool-name` |

Before deploying, at minimum:

1. Request or import an ACM certificate covering `domainName`, issued in
   `us-east-1` (see [Regions](#regions)), and set `certificateArn`.
2. Set `domainName` to your real domain.
3. Decide whether Route 53 manages your DNS. If yes, set `hostedZoneId`;
   if no, leave it empty and use the `CloudFrontDomainName` output to
   create the record manually wherever your DNS actually lives.
4. Rename `apiName`, `dynamoTableName`, `lambdaFunctionName`, and
   `cognitoUserPoolName` to something meaningful for your project.
5. Replace the `/items` resource and the Lambda handler stub
   (`lambda/handler.ts`) with your actual API surface.

## Cost breakdown

Approximate US pricing, before any request/data-transfer volume charges:

| Resource | Approximate cost |
| --- | --- |
| Interface VPC Endpoint (execute-api) | ~$15/month (roughly $0.01/hour per AZ, x2 AZs by default) |
| Internal Application Load Balancer | ~$16/month base, plus LCU usage |
| CloudFront Business support plan | **$200/month minimum** -- required for VPC Origins, and this is an account-level support plan cost, not a per-distribution cost |
| DynamoDB (on-demand) | Usage-based, no fixed minimum |
| Lambda | Usage-based, no fixed minimum |
| Cognito | Free tier covers most small user pools; usage-based beyond that |

The CloudFront Business plan cost dominates everything else in this
architecture. If you are not already paying for it for other reasons,
factor that in before committing to this pattern -- see the callout at the
top of this README for a cheaper alternative.

## Deploying

```
npm install
npm run build
cdk synth   # sanity-check the generated CloudFormation
cdk deploy
```

`cdk synth` will succeed even with the placeholder `certificateArn` left
empty (CDK does not validate ARN format until the value is actually used
against a real AWS API), but `cdk deploy` will fail until you provide a
real certificate.

## Regions

This template's `bin/private-api-gateway-template.ts` pins the stack to
`us-east-1`. That is a deliberate constraint, not an oversight, and comes
from two independent AWS requirements:

1. A WAF WebACL scoped to `CLOUDFRONT` (as opposed to a regional WebACL)
   can only be created in `us-east-1`.
2. An ACM certificate used for a CloudFront alternate domain name must
   also be issued in `us-east-1`.

Because this template reuses the same `certificateArn` for both the
CloudFront distribution and the internal ALB's HTTPS listener, the ALB
(and therefore the rest of the stack) also ends up in `us-east-1`. If you
need the ALB/API/Lambda/DynamoDB stack to live in a different region,
split the single `certificateArn` config value into two separate
certificates (one per region) and adjust the stack accordingly.
