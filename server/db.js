const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

// DYNAMODB_ENDPOINT points at DynamoDB Local (CI). On AWS, credentials come
// from the instance role; locally, from the AWS CLI login.
const client = new DynamoDBClient({
  region:   process.env.AWS_REGION || 'us-east-2',
  endpoint: process.env.DYNAMODB_ENDPOINT || undefined,
});

const db = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLE = process.env.TABLE_NAME || 'maintenance-tracker-dev';

module.exports = { db, client, TABLE };
