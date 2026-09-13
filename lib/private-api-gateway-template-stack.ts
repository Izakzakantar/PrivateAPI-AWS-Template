import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as elbv2Targets from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from "aws-cdk-lib/custom-resources";
import { loadConfig, PrivateApiGatewayConfig } from "./config";

export interface PrivateApiGatewayStackProps extends cdk.StackProps {
  /**
   * Optional programmatic overrides for the template's config values.
   * Anything omitted falls back to the "privateApiGateway" block in
   * cdk.json context, then to the built-in defaults in config.ts.
   */
  readonly config?: Partial<PrivateApiGatewayConfig>;
}

/**
 * Reference architecture:
 *
 *   Client -> Route 53 (optional) -> CloudFront -> CloudFront VPC Origin
 *     -> Internal ALB -> VPC Endpoint (PrivateLink) -> Private API Gateway
 *     -> Lambda -> DynamoDB
 *
 * Cognito issues JWTs; API Gateway validates them with a Cognito authorizer
 * before a request ever reaches Lambda.
 *
 * This is intentionally kept as a single stack for readability. Sections
 * below are grouped and commented by architectural layer:
 *   1. NETWORKING  - VPC, subnets, security groups, VPC endpoint
 *   2. DATA        - DynamoDB table
 *   3. COMPUTE     - Lambda function
 *   4. IDENTITY    - Cognito user pool + app client
 *   5. API         - Private REST API Gateway + resource policy + authorizer
 *   6. BRIDGE      - Internal ALB that fronts the VPC endpoint
 *   7. EDGE        - WAF + CloudFront distribution
 *   8. DNS         - Optional Route 53 record, or a CfnOutput fallback
 */
export class PrivateApiGatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: PrivateApiGatewayStackProps) {
    super(scope, id, props);

    const config = loadConfig(
      this.node.tryGetContext("privateApiGateway"),
      props?.config
    );

    // ------------------------------------------------------------------
    // 1. NETWORKING
    // ------------------------------------------------------------------
    // A VPC with only private, isolated subnets. Nothing in this
    // architecture needs to initiate outbound internet traffic (Lambda
    // runs outside the VPC; DynamoDB and Cognito are reached over the
    // AWS API surface, not through this VPC), so there is no NAT gateway
    // and no internet gateway -- one less thing to pay for and secure.
    const vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr(config.vpcCidr),
      maxAzs: config.maxAzs,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "private-isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // The CloudFront-managed prefix list for origin-facing IP ranges.
    // This is account/region-scoped and has no fixed ID, so it is looked
    // up at deploy time instead of being hardcoded.
    const cloudFrontPrefixListLookup = new AwsCustomResource(
      this,
      "CloudFrontOriginFacingPrefixListLookup",
      {
        onCreate: {
          service: "EC2",
          action: "describeManagedPrefixLists",
          parameters: {
            Filters: [
              {
                Name: "prefix-list-name",
                Values: ["com.amazonaws.global.cloudfront.origin-facing"],
              },
            ],
          },
          physicalResourceId: PhysicalResourceId.of(
            "CloudFrontOriginFacingPrefixListLookup"
          ),
        },
        policy: AwsCustomResourcePolicy.fromSdkCalls({
          resources: AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
        installLatestAwsSdk: false,
      }
    );
    const cloudFrontPrefixListId = cloudFrontPrefixListLookup.getResponseField(
      "PrefixLists.0.PrefixListId"
    );

    // ALB security group: only CloudFront's origin-facing IP ranges may
    // reach the ALB on 443.
    const albSecurityGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
      vpc,
      description: "Internal ALB - allows HTTPS from CloudFront only",
      allowAllOutbound: true,
    });
    albSecurityGroup.addIngressRule(
      ec2.Peer.prefixList(cloudFrontPrefixListId),
      ec2.Port.tcp(443),
      "HTTPS from CloudFront origin-facing IP ranges"
    );

    // VPC endpoint security group: only the ALB may reach the endpoint.
    const vpcEndpointSecurityGroup = new ec2.SecurityGroup(
      this,
      "VpcEndpointSecurityGroup",
      {
        vpc,
        description: "execute-api VPC endpoint - allows HTTPS from the internal ALB only",
        allowAllOutbound: true,
      }
    );
    vpcEndpointSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(albSecurityGroup.securityGroupId),
      ec2.Port.tcp(443),
      "HTTPS from the internal ALB"
    );

    // Interface VPC endpoint for execute-api. This is the PrivateLink
    // "door" into API Gateway -- see README "How PrivateLink Works".
    const apiGatewayVpcEndpoint = new ec2.InterfaceVpcEndpoint(
      this,
      "ApiGatewayVpcEndpoint",
      {
        vpc,
        service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [vpcEndpointSecurityGroup],
        privateDnsEnabled: true,
      }
    );

    // ------------------------------------------------------------------
    // 2. DATA
    // ------------------------------------------------------------------
    const table = new dynamodb.Table(this, "Table", {
      tableName: config.dynamoTableName,
      partitionKey: {
        name: config.partitionKeyName,
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: config.sortKeyName,
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Template default. Switch to RETAIN before using this for anything
      // that holds real data.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ------------------------------------------------------------------
    // 3. COMPUTE
    // ------------------------------------------------------------------
    // Lambda intentionally runs outside the VPC: API Gateway invokes it
    // over the Lambda service API (not through the VPC endpoint), and it
    // only needs to reach DynamoDB, which it does over the public AWS
    // API surface. Putting it inside the VPC would require a DynamoDB
    // gateway endpoint or a NAT gateway for no security benefit here.
    const handlerFunction = new NodejsFunction(this, "HandlerFunction", {
      functionName: config.lambdaFunctionName,
      entry: path.join(__dirname, "..", "lambda", "handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(10),
      environment: {
        TABLE_NAME: table.tableName,
        PARTITION_KEY: config.partitionKeyName,
        SORT_KEY: config.sortKeyName,
      },
      bundling: {
        // The Node.js 22 managed runtime ships the AWS SDK v3, so exclude
        // it from the bundle to keep deploys fast.
        externalModules: ["@aws-sdk/client-dynamodb", "@aws-sdk/lib-dynamodb"],
      },
    });
    table.grantReadWriteData(handlerFunction);

    // ------------------------------------------------------------------
    // 4. IDENTITY
    // ------------------------------------------------------------------
    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: config.cognitoUserPoolName,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolClient = new cognito.UserPoolClient(this, "UserPoolClient", {
      userPool,
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      generateSecret: false,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
      },
    });

    // ------------------------------------------------------------------
    // 5. API
    // ------------------------------------------------------------------
    // Private REST API: its execute-api URL does not resolve outside the
    // VPC at all once the endpoint policy below is attached. See README
    // "Why a Private API".
    const api = new apigateway.RestApi(this, "Api", {
      restApiName: config.apiName,
      endpointConfiguration: {
        types: [apigateway.EndpointType.PRIVATE],
        vpcEndpoints: [apiGatewayVpcEndpoint],
      },
      deployOptions: {
        stageName: "prod",
      },
      // Resource policy: only requests arriving through this specific VPC
      // endpoint are allowed to invoke the API. This is what makes the
      // API "private" -- without it, a PRIVATE endpoint type alone still
      // requires an explicit policy to actually restrict access.
      policy: new cdk.aws_iam.PolicyDocument({
        statements: [
          new cdk.aws_iam.PolicyStatement({
            effect: cdk.aws_iam.Effect.DENY,
            principals: [new cdk.aws_iam.AnyPrincipal()],
            actions: ["execute-api:Invoke"],
            resources: ["execute-api:/*"],
            conditions: {
              StringNotEquals: {
                "aws:SourceVpce": apiGatewayVpcEndpoint.vpcEndpointId,
              },
            },
          }),
          new cdk.aws_iam.PolicyStatement({
            effect: cdk.aws_iam.Effect.ALLOW,
            principals: [new cdk.aws_iam.AnyPrincipal()],
            actions: ["execute-api:Invoke"],
            resources: ["execute-api:/*"],
          }),
        ],
      }),
    });

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      "Authorizer",
      {
        cognitoUserPools: [userPool],
        identitySource: "method.request.header.Authorization",
      }
    );

    const integration = new apigateway.LambdaIntegration(handlerFunction);

    // Generic placeholder resource -- rename/replace with whatever your
    // actual API surface looks like.
    const items = api.root.addResource("items");
    items.addMethod("GET", integration, {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    items.addMethod("POST", integration, {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // ------------------------------------------------------------------
    // 6. BRIDGE
    // ------------------------------------------------------------------
    // CloudFront's VPC Origins feature can only target an ALB, an NLB, or
    // an EC2 instance -- a VPC endpoint is not a supported origin type.
    // This internal ALB exists purely to bridge that gap. See README
    // "How PrivateLink Works" for the full explanation.
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      "Certificate",
      config.certificateArn
    );

    const alb = new elbv2.ApplicationLoadBalancer(this, "InternalAlb", {
      vpc,
      internetFacing: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroup: albSecurityGroup,
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, "TargetGroup", {
      vpc,
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        protocol: elbv2.Protocol.HTTPS,
        path: "/",
        // A bare request to the execute-api endpoint without the API ID
        // host header/SNI that a real client would present comes back as
        // 403 by design -- that is still a "the endpoint is alive"
        // signal, so both codes are treated as healthy.
        healthyHttpCodes: "200,403",
      },
    });

    alb.addListener("HttpsListener", {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [elbv2.ListenerCertificate.fromArn(config.certificateArn)],
      defaultTargetGroups: [targetGroup],
    });

    // The VPC endpoint's ENI IPs are not known until deploy time, so they
    // are resolved here via a custom resource and registered as IP
    // targets. vpcEndpointNetworkInterfaceIds already carries one ENI ID
    // per subnet the endpoint was created in.
    const eniLookup = new AwsCustomResource(this, "VpcEndpointEniLookup", {
      onCreate: {
        service: "EC2",
        action: "describeNetworkInterfaces",
        parameters: {
          NetworkInterfaceIds: apiGatewayVpcEndpoint.vpcEndpointNetworkInterfaceIds,
        },
        physicalResourceId: PhysicalResourceId.of("VpcEndpointEniLookup"),
      },
      onUpdate: {
        service: "EC2",
        action: "describeNetworkInterfaces",
        parameters: {
          NetworkInterfaceIds: apiGatewayVpcEndpoint.vpcEndpointNetworkInterfaceIds,
        },
        physicalResourceId: PhysicalResourceId.of("VpcEndpointEniLookup"),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      installLatestAwsSdk: false,
    });
    eniLookup.node.addDependency(apiGatewayVpcEndpoint);

    for (let i = 0; i < config.maxAzs; i++) {
      const privateIp = eniLookup.getResponseField(
        `NetworkInterfaces.${i}.PrivateIpAddress`
      );
      targetGroup.addTarget(new elbv2Targets.IpTarget(privateIp, 443));
    }

    // ------------------------------------------------------------------
    // 7. EDGE
    // ------------------------------------------------------------------
    const webAcl = new wafv2.CfnWebACL(this, "WebAcl", {
      // CLOUDFRONT-scoped WAF WebACLs must be created in us-east-1.
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `${config.apiName}-web-acl`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: "AWS-AWSManagedRulesCommonRuleSet",
          priority: 0,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "AWSManagedRulesCommonRuleSet",
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // NOTE: CloudFront VPC Origins require the CloudFront Business (or
    // higher) support plan, at a minimum of ~$200/month. See the
    // README callout before deploying this section.
    const vpcOrigin = origins.VpcOrigin.withApplicationLoadBalancer(alb, {
      // Forwarded to the ALB target so the request can be routed on to
      // the correct API once it reaches the VPC endpoint.
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      // A single execute-api VPC endpoint can front multiple private APIs
      // in the same account/region -- this header tells the endpoint
      // which one to route to.
      customHeaders: { "x-apigw-api-id": api.restApiId },
    });

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: vpcOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
      domainNames: [config.domainName],
      certificate,
      webAclId: webAcl.attrArn,
    });

    // ------------------------------------------------------------------
    // 8. DNS
    // ------------------------------------------------------------------
    if (config.hostedZoneId) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, "HostedZone", {
        hostedZoneId: config.hostedZoneId,
        zoneName: config.domainName,
      });
      new route53.ARecord(this, "AliasRecord", {
        zone,
        recordName: config.domainName,
        target: route53.RecordTarget.fromAlias(
          new targets.CloudFrontTarget(distribution)
        ),
      });
    } else {
      new cdk.CfnOutput(this, "CloudFrontDomainName", {
        value: distribution.distributionDomainName,
        description:
          "No hostedZoneId configured -- point your DNS provider's CNAME/ALIAS " +
          `record for ${config.domainName} at this CloudFront domain manually.`,
      });
    }

    // ------------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, "ApiId", { value: api.restApiId });
    new cdk.CfnOutput(this, "DistributionId", { value: distribution.distributionId });
    new cdk.CfnOutput(this, "AlbDnsName", { value: alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
  }
}
