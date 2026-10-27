// Runs against the table named by TABLE_NAME (and DYNAMODB_ENDPOINT, if set).
// Each run uses a fresh test user, so it never touches real data.
require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { db, TABLE } = require('../server/db');
const store = require('../server/store');
const DynamoSessionStore = require('../server/session-store');

const userId  = `test-${crypto.randomUUID()}`;
const otherId = `test-${crypto.randomUUID()}`;
const created = [];

async function newProfile(owner = userId, name = `p-${crypto.randomUUID()}`) {
  const p = await store.createProfile(owner, { name, unit: 'kg' });
  created.push([owner, p.id]);
  return p;
}

after(async () => {
  for (const [owner, id] of created) await store.deleteProfile(owner, id);
  await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `USER#${userId}`, sk: 'META' } }));
});

test('upsertUser creates and then updates a user', async () => {
  await store.upsertUser({ id: userId, email: 'a@example.com', name: 'A' });
  await store.upsertUser({ id: userId, email: 'b@example.com', name: 'B' });
  assert.deepEqual(await store.getUser(userId), { id: userId, email: 'b@example.com', name: 'B' });
  assert.equal(await store.getUser(`missing-${userId}`), null);
});

test('profiles are listed in creation order with entry counts', async () => {
  const a = await newProfile(userId, 'Alpha');
  const b = await newProfile(userId, 'Beta');
  await store.addEntry(a.id, { date: '2026-01-01', weight: 80, calories: 2500 });
  await store.addEntry(a.id, { date: '2026-01-02', weight: 79.5, calories: 2400 });

  const list = await store.listProfiles(userId);
  const mine = list.filter(p => [a.id, b.id].includes(p.id));
  assert.deepEqual(mine, [
    { id: a.id, name: 'Alpha', unit: 'kg', entry_count: 2 },
    { id: b.id, name: 'Beta',  unit: 'kg', entry_count: 0 },
  ]);
});

test('duplicate profile name for the same user is a conflict', async () => {
  await newProfile(userId, 'Dup');
  await assert.rejects(store.createProfile(userId, { name: 'Dup', unit: 'lbs' }), store.ConflictError);
});

test('the same profile name is allowed for a different user', async () => {
  await newProfile(userId, 'Shared');
  await newProfile(otherId, 'Shared');
});

test('profiles are only visible to their owner', async () => {
  const p = await newProfile();
  assert.equal(await store.getProfile(otherId, p.id), null);
  assert.ok(!(await store.listProfiles(otherId)).some(x => x.id === p.id));
});

test('entries are returned sorted by date with stable ids', async () => {
  const p = await newProfile();
  await store.addEntry(p.id, { date: '2026-03-02', weight: 70.25, calories: 2000 });
  await store.addEntry(p.id, { date: '2026-03-01', weight: 70.5, calories: 2100 });

  assert.deepEqual(await store.listEntries(p.id), [
    { id: `${p.id}_2026-03-01`, date: '2026-03-01', weight: 70.5,  calories: 2100 },
    { id: `${p.id}_2026-03-02`, date: '2026-03-02', weight: 70.25, calories: 2000 },
  ]);
});

test('duplicate entry date is a conflict', async () => {
  const p = await newProfile();
  await store.addEntry(p.id, { date: '2026-04-01', weight: 70, calories: 2000 });
  await assert.rejects(
    store.addEntry(p.id, { date: '2026-04-01', weight: 71, calories: 2100 }),
    store.ConflictError,
  );
});

test('deleteEntry removes an entry only for the owner', async () => {
  const p = await newProfile();
  const e = await store.addEntry(p.id, { date: '2026-05-01', weight: 70, calories: 2000 });

  await store.deleteEntry(otherId, e.id);
  assert.equal((await store.listEntries(p.id)).length, 1);

  await store.deleteEntry(userId, e.id);
  assert.equal((await store.listEntries(p.id)).length, 0);

  await store.deleteEntry(userId, 'not-a-valid-id');
});

test('deleteProfile removes the profile, its name and all entries (more than 25)', async () => {
  const p = await store.createProfile(userId, { name: 'Big', unit: 'lbs' });
  for (let day = 1; day <= 30; day++) {
    const date = `2026-06-${String(day).padStart(2, '0')}`;
    await store.addEntry(p.id, { date, weight: 150, calories: 2500 });
  }

  await store.deleteProfile(otherId, p.id);
  assert.ok(await store.getProfile(userId, p.id), 'another user cannot delete it');

  await store.deleteProfile(userId, p.id);
  assert.equal(await store.getProfile(userId, p.id), null);
  assert.equal((await store.listEntries(p.id)).length, 0);

  // The name is free again.
  await newProfile(userId, 'Big');
});

test('session store saves, expires and destroys sessions', async () => {
  const sessions = new DynamoSessionStore();
  const call = (method, ...args) =>
    new Promise((resolve, reject) => sessions[method](...args, (err, v) => (err ? reject(err) : resolve(v))));

  const sid = `test-${crypto.randomUUID()}`;
  const future = { cookie: { expires: new Date(Date.now() + 60_000).toISOString() }, passport: { user: userId } };
  await call('set', sid, future);
  assert.deepEqual(await call('get', sid), future);

  await call('touch', sid, future);
  await call('destroy', sid);
  assert.equal(await call('get', sid), null);

  const expired = { cookie: { expires: new Date(Date.now() - 1000).toISOString() } };
  await call('set', sid, expired);
  assert.equal(await call('get', sid), null, 'expired sessions read as missing');
  await call('destroy', sid);
});
