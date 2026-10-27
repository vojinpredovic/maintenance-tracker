const session = require('express-session');
const { GetCommand, PutCommand, UpdateCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { db, TABLE } = require('./db');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

const key = sid => ({ pk: `SESSION#${sid}`, sk: 'META' });

// Seconds since epoch, the format DynamoDB TTL expects.
function expiresAt(sess) {
  const ms = sess?.cookie?.expires
    ? new Date(sess.cookie.expires).getTime()
    : Date.now() + DEFAULT_TTL_MS;
  return Math.floor(ms / 1000);
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

// Sessions live in the app table. DynamoDB TTL removes expired items, but can
// take a day or two to do so, so get() also checks expiresAt itself.
class DynamoSessionStore extends session.Store {
  get(sid, cb) {
    db.send(new GetCommand({ TableName: TABLE, Key: key(sid) }))
      .then(({ Item }) => {
        if (!Item || Item.expiresAt <= nowSeconds()) return cb(null, null);
        cb(null, JSON.parse(Item.sess));
      })
      .catch(cb);
  }

  set(sid, sess, cb = () => {}) {
    db.send(new PutCommand({
      TableName: TABLE,
      Item: { ...key(sid), sess: JSON.stringify(sess), expiresAt: expiresAt(sess) },
    }))
      .then(() => cb(null))
      .catch(cb);
  }

  touch(sid, sess, cb = () => {}) {
    db.send(new UpdateCommand({
      TableName: TABLE,
      Key: key(sid),
      UpdateExpression: 'SET expiresAt = :exp',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: { ':exp': expiresAt(sess) },
    }))
      .then(() => cb(null))
      .catch(err => cb(err.name === 'ConditionalCheckFailedException' ? null : err));
  }

  destroy(sid, cb = () => {}) {
    db.send(new DeleteCommand({ TableName: TABLE, Key: key(sid) }))
      .then(() => cb(null))
      .catch(cb);
  }
}

module.exports = DynamoSessionStore;
