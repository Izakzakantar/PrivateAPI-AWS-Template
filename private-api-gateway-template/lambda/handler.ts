import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

const TABLE_NAME = process.env.TABLE_NAME as string;
const PARTITION_KEY = process.env.PARTITION_KEY as string;
const SORT_KEY = process.env.SORT_KEY as string;

function jsonResponse(
  statusCode: number,
  body: Record<string, unknown>
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * Generic REST API (event.httpMethod) handler stub.
 *
 * GET  /items?{partitionKey}=value                -> query all items for that key
 * GET  /items?{partitionKey}=value&{sortKey}=value -> fetch a single item
 * POST /items  (JSON body containing both keys)    -> put an item
 *
 * Replace this logic with real business behavior -- this stub only proves
 * the wiring from API Gateway through to DynamoDB works end to end.
 */
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    switch (event.httpMethod) {
      case "GET":
        return await handleGet(event);
      case "POST":
        return await handlePost(event);
      default:
        return jsonResponse(405, { message: "Method not allowed" });
    }
  } catch (err) {
    console.error("Unhandled error", err);
    return jsonResponse(500, { message: "Internal server error" });
  }
};

async function handleGet(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const params = event.queryStringParameters ?? {};
  const partitionValue = params[PARTITION_KEY];

  if (!partitionValue) {
    return jsonResponse(400, {
      message: `Missing required query parameter: ${PARTITION_KEY}`,
    });
  }

  const sortValue = params[SORT_KEY];

  if (sortValue) {
    const result = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { [PARTITION_KEY]: partitionValue, [SORT_KEY]: sortValue },
      })
    );
    return jsonResponse(200, { item: result.Item ?? null });
  }

  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: { "#pk": PARTITION_KEY },
      ExpressionAttributeValues: { ":pk": partitionValue },
    })
  );
  return jsonResponse(200, { items: result.Items ?? [] });
}

async function handlePost(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  if (!event.body) {
    return jsonResponse(400, { message: "Missing request body" });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return jsonResponse(400, { message: "Request body must be valid JSON" });
  }

  if (!payload[PARTITION_KEY] || !payload[SORT_KEY]) {
    return jsonResponse(400, {
      message: `Request body must include "${PARTITION_KEY}" and "${SORT_KEY}"`,
    });
  }

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: payload,
    })
  );

  return jsonResponse(201, { message: "Item created", item: payload });
}
