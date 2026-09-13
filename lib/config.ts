/**
 * All values a consumer of this template needs to review before deploying.
 * Nothing architectural should be hardcoded elsewhere in the stack -- if you
 * find yourself adding a project-specific literal outside of this file,
 * add a field here instead.
 *
 * Defaults live in cdk.json under the "privateApiGateway" context key.
 * Override them per-deployment with `-c` flags, e.g.:
 *   cdk deploy -c privateApiGateway:domainName=api.mycompany.com
 */
export interface PrivateApiGatewayConfig {
  /** Name given to the API Gateway REST API. */
  readonly apiName: string;

  /**
   * Public-facing domain name that CloudFront will answer for
   * (e.g. "api.example.com"). Must match the certificate in certificateArn.
   */
  readonly domainName: string;

  /**
   * ACM certificate ARN used by both the CloudFront distribution and the
   * internal ALB's HTTPS listener. Left empty by default -- the consumer
   * must request/import a certificate and fill this in before deploying.
   *
   * NOTE: because a CloudFront-scoped WAF WebACL and CloudFront's alternate
   * domain certificate must both live in us-east-1, this template assumes
   * the whole stack is deployed to us-east-1 so a single certificate can
   * cover both the ALB listener and the CloudFront distribution. If you
   * need the ALB in a different region, split the certificate into two
   * and adjust the stack accordingly.
   */
  readonly certificateArn: string;

  /** CIDR range for the VPC. Defaults to 10.0.0.0/16. */
  readonly vpcCidr: string;

  /** Number of Availability Zones (and matching private subnets) to use. */
  readonly maxAzs: number;

  /** DynamoDB table name. */
  readonly dynamoTableName: string;

  /** DynamoDB partition key attribute name. */
  readonly partitionKeyName: string;

  /** DynamoDB sort key attribute name. */
  readonly sortKeyName: string;

  /** Name given to the backing Lambda function. */
  readonly lambdaFunctionName: string;

  /** Name given to the Cognito User Pool. */
  readonly cognitoUserPoolName: string;

  /**
   * Optional Route 53 hosted zone ID. When provided, an ALIAS record for
   * `domainName` is created automatically pointing at CloudFront. When
   * omitted (the default), no DNS record is created -- the CloudFront
   * domain name is emitted as a CfnOutput instead, so it can be wired up
   * manually in whatever DNS provider is actually in use.
   */
  readonly hostedZoneId?: string;
}

const DEFAULT_CONFIG: PrivateApiGatewayConfig = {
  apiName: "your-api-name",
  domainName: "api.example.com",
  certificateArn: "",
  vpcCidr: "10.0.0.0/16",
  maxAzs: 2,
  dynamoTableName: "your-table-name",
  partitionKeyName: "userId",
  sortKeyName: "itemId",
  lambdaFunctionName: "your-function-name",
  cognitoUserPoolName: "your-user-pool-name",
  hostedZoneId: "",
};

/**
 * Merges (in increasing priority): built-in defaults, cdk.json context,
 * and explicit overrides passed as stack props.
 */
export function loadConfig(
  contextValue: unknown,
  overrides?: Partial<PrivateApiGatewayConfig>
): PrivateApiGatewayConfig {
  const fromContext =
    typeof contextValue === "object" && contextValue !== null
      ? (contextValue as Partial<PrivateApiGatewayConfig>)
      : {};

  const merged: PrivateApiGatewayConfig = {
    ...DEFAULT_CONFIG,
    ...fromContext,
    ...overrides,
  };

  // Normalize an empty-string hostedZoneId to undefined so downstream
  // "if (config.hostedZoneId)" checks behave as expected.
  return {
    ...merged,
    hostedZoneId: merged.hostedZoneId || undefined,
  };
}
