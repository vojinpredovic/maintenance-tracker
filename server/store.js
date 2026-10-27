const crypto = require('crypto');
const {
  GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand,
  BatchWriteCommand, TransactWriteCommand,
} = require('@aws-sdk/lib-dynamodb');
const { db, TABLE } = require('./db');

// Single-table layout (see docs/aws-migration.md §5):
//   USER#<googleId>     META                  user
//   USER#<googleId>     PROFILE#<profileId>   profile
//   USER#<googleId>     PROFILENAME#<name>    uniqueness guard for profile names
//   PROFILE#<profileId> ENTRY#<yyyy-mm-dd>    entry

class ConflictError extends Error {}

const userKey    = id => `USER#${id}`;
const profileKey = id => `PROFILE#${id}`;

// Entries are keyed by profile + date, so the API's entry id carries both.
// UUIDs never contain "_".
const entryId = (profileId, date) => `${profileId}_${date}`;

function parseEntryId(id) {
  const [profileId, date, ...rest] = String(id).split('_');
  if (!profileId || !date || rest.length) return null;
  return { profileId, date };
}

const isConditionFailure = err =>
  err.name === 'ConditionalCheckFailedException' ||
  (err.name === 'TransactionCanceledException' &&
    err.CancellationReasons?.some(r => r.Code === 'ConditionalCheckFailed'));

// Follows LastEvaluatedKey so callers always get every page.
async function queryAll(params) {
  const items = [];
  let count = 0;
  let ExclusiveStartKey;
  do {
    const res = await db.send(new QueryCommand({ TableName: TABLE, ...params, ExclusiveStartKey }));
    if (res.Items) items.push(...res.Items);
    count += res.Count ?? 0;
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return { items, count };
}

// ── Users ───────────────────────────────────────────────────────

async function upsertUser({ id, email, name }) {
  const { Attributes } = await db.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: userKey(id), sk: 'META' },
    UpdateExpression: 'SET email = :email, #name = :name, createdAt = if_not_exists(createdAt, :now)',
    ExpressionAttributeNames: { '#name': 'name' },
    ExpressionAttributeValues: { ':email': email, ':name': name, ':now': new Date().toISOString() },
    ReturnValues: 'ALL_NEW',
  }));
  return { id, email: Attributes.email, name: Attributes.name };
}

async function getUser(id) {
  const { Item } = await db.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: userKey(id), sk: 'META' },
  }));
  return Item ? { id, email: Item.email, name: Item.name } : null;
}

// ── Profiles ────────────────────────────────────────────────────

async function getProfile(userId, profileId) {
  const { Item } = await db.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: userKey(userId), sk: profileKey(profileId) },
  }));
  return Item ? { id: Item.profileId, name: Item.name, unit: Item.unit } : null;
}

async function listProfiles(userId) {
  const { items } = await queryAll({
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': userKey(userId), ':prefix': 'PROFILE#' },
  });
  items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return Promise.all(items.map(async p => {
    const { count } = await queryAll({
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': profileKey(p.profileId) },
      Select: 'COUNT',
    });
    return { id: p.profileId, name: p.name, unit: p.unit, entry_count: count };
  }));
}

async function createProfile(userId, { name, unit }) {
  const profileId = crypto.randomUUID();
  try {
    await db.send(new TransactWriteCommand({
      TransactItems: [
        { Put: {
          TableName: TABLE,
          Item: {
            pk: userKey(userId), sk: profileKey(profileId),
            profileId, name, unit, createdAt: new Date().toISOString(),
          },
        } },
        { Put: {
          TableName: TABLE,
          Item: { pk: userKey(userId), sk: `PROFILENAME#${name}`, profileId },
          ConditionExpression: 'attribute_not_exists(pk)',
        } },
      ],
    }));
  } catch (err) {
    if (isConditionFailure(err)) throw new ConflictError('A profile with this name already exists.');
    throw err;
  }
  return { id: profileId, name, unit };
}

// Deletes the profile first, then its entries: if this is interrupted, the
// leftover entries belong to no visible profile and can't be reached.
async function deleteProfile(userId, profileId) {
  const profile = await getProfile(userId, profileId);
  if (!profile) return;

  await db.send(new TransactWriteCommand({
    TransactItems: [
      { Delete: { TableName: TABLE, Key: { pk: userKey(userId), sk: profileKey(profileId) } } },
      { Delete: { TableName: TABLE, Key: { pk: userKey(userId), sk: `PROFILENAME#${profile.name}` } } },
    ],
  }));

  const { items } = await queryAll({
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': profileKey(profileId) },
    ProjectionExpression: 'pk, sk',
  });
  for (let i = 0; i < items.length; i += 25) {
    await batchDelete(items.slice(i, i + 25));
  }
}

async function batchDelete(keys) {
  let requests = keys.map(Key => ({ DeleteRequest: { Key } }));
  for (let attempt = 0; requests.length; attempt++) {
    if (attempt > 8) throw new Error('Batch delete did not complete.');
    if (attempt > 0) await new Promise(r => setTimeout(r, 50 * 2 ** attempt));
    const res = await db.send(new BatchWriteCommand({ RequestItems: { [TABLE]: requests } }));
    requests = res.UnprocessedItems?.[TABLE] ?? [];
  }
}

// ── Entries ─────────────────────────────────────────────────────

const toEntry = (profileId, item) => ({
  id:       entryId(profileId, item.sk.slice('ENTRY#'.length)),
  date:     item.sk.slice('ENTRY#'.length),
  weight:   item.weight,
  calories: item.calories,
});

async function listEntries(profileId) {
  const { items } = await queryAll({
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': profileKey(profileId), ':prefix': 'ENTRY#' },
  });
  return items.map(item => toEntry(profileId, item));
}

async function addEntry(profileId, { date, weight, calories }) {
  const item = {
    pk: profileKey(profileId), sk: `ENTRY#${date}`,
    weight, calories, createdAt: new Date().toISOString(),
  };
  try {
    await db.send(new PutCommand({
      TableName: TABLE,
      Item: item,
      ConditionExpression: 'attribute_not_exists(sk)',
    }));
  } catch (err) {
    if (isConditionFailure(err)) throw new ConflictError('An entry for this date already exists.');
    throw err;
  }
  return toEntry(profileId, item);
}

async function deleteEntry(userId, id) {
  const parsed = parseEntryId(id);
  if (!parsed) return;
  if (!(await getProfile(userId, parsed.profileId))) return;
  await db.send(new DeleteCommand({
    TableName: TABLE,
    Key: { pk: profileKey(parsed.profileId), sk: `ENTRY#${parsed.date}` },
  }));
}

module.exports = {
  ConflictError,
  upsertUser, getUser,
  getProfile, listProfiles, createProfile, deleteProfile,
  listEntries, addEntry, deleteEntry,
};
