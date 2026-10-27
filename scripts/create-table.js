// Creates the app's DynamoDB table (see docs/aws-migration.md §5 and §6.5).
// Usage: npm run create-table -- <name> [rcu] [wcu]
// Running it again against an existing table changes nothing.
require('dotenv').config();
const {
  CreateTableCommand, DescribeTableCommand, UpdateTimeToLiveCommand,
  UpdateContinuousBackupsCommand, waitUntilTableExists,
} = require('@aws-sdk/client-dynamodb');
const { client } = require('../server/db');

const [name = process.env.TABLE_NAME, rcu = '5', wcu = '5'] = process.argv.slice(2);
const isLocal = Boolean(process.env.DYNAMODB_ENDPOINT);

async function tableExists() {
  try {
    await client.send(new DescribeTableCommand({ TableName: name }));
    return true;
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') return false;
    throw err;
  }
}

async function main() {
  if (!name) throw new Error('Pass a table name or set TABLE_NAME.');

  if (await tableExists()) {
    console.log(`Table ${name} already exists, nothing to do.`);
    return;
  }

  await client.send(new CreateTableCommand({
    TableName: name,
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    // Provisioned, not on-demand: only provisioned capacity is in the always-free tier.
    BillingMode: 'PROVISIONED',
    ProvisionedThroughput: { ReadCapacityUnits: Number(rcu), WriteCapacityUnits: Number(wcu) },
    DeletionProtectionEnabled: !isLocal,
  }));
  await waitUntilTableExists({ client, maxWaitTime: 120 }, { TableName: name });

  if (!isLocal) {
    await client.send(new UpdateTimeToLiveCommand({
      TableName: name,
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    }));

    await client.send(new UpdateContinuousBackupsCommand({
      TableName: name,
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    }));
  }

  console.log(`Created table ${name} (${rcu} RCU / ${wcu} WCU).`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
