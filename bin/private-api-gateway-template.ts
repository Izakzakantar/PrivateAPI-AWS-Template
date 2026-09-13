#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { PrivateApiGatewayStack } from "../lib/private-api-gateway-template-stack";

const app = new cdk.App();

// NOTE: this stack must be deployed to us-east-1. Two AWS constraints force
// this for a single-stack template: (1) the CloudFront-scoped WAFv2 WebACL
// only exists in us-east-1, and (2) the ACM certificate used for CloudFront's
// alternate domain name must also be issued in us-east-1. Reusing the same
// certificate for the internal ALB listener then requires the ALB (and the
// rest of the stack) to live in us-east-1 as well. See README.md for the
// tradeoffs if you need to split this across regions.
new PrivateApiGatewayStack(app, "PrivateApiGatewayTemplateStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: "us-east-1",
  },
});
