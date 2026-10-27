const { Router } = require('express');
const store = require('./store');

const router = Router();

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// ── Validation ──────────────────────────────────────────────────
// Postgres used to reject bad values through its column types; DynamoDB
// stores whatever it's given, so the checks live here now.

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function parseWeight(v) {
  const n = Number(v);
  if (v === '' || v == null || !Number.isFinite(n) || n <= 0 || n >= 10000) return null;
  return Math.round(n * 100) / 100;
}

function parseCalories(v) {
  const n = Number(v);
  if (v === '' || v == null || !Number.isInteger(n) || n <= 0 || n >= 100000) return null;
  return n;
}

// ── Current user ────────────────────────────────────────────────

router.get('/me', requireAuth, (req, res) => {
  const { id, email, name } = req.user;
  res.json({ id, email, name });
});

// ── Profiles ────────────────────────────────────────────────────

router.get('/profiles', requireAuth, wrap(async (req, res) => {
  res.json(await store.listProfiles(req.user.id));
}));

router.post('/profiles', requireAuth, wrap(async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const { unit } = req.body;
  if (!name || name.length > 40 || !['kg', 'lbs'].includes(unit)) {
    return res.status(400).json({ error: 'Invalid name or unit.' });
  }

  try {
    res.status(201).json(await store.createProfile(req.user.id, { name, unit }));
  } catch (err) {
    if (err instanceof store.ConflictError) return res.status(409).json({ error: err.message });
    throw err;
  }
}));

router.delete('/profiles/:id', requireAuth, wrap(async (req, res) => {
  await store.deleteProfile(req.user.id, req.params.id);
  res.sendStatus(204);
}));

// ── Entries ─────────────────────────────────────────────────────

router.get('/profiles/:id/entries', requireAuth, wrap(async (req, res) => {
  if (!(await store.getProfile(req.user.id, req.params.id))) {
    return res.status(404).json({ error: 'Profile not found.' });
  }
  res.json(await store.listEntries(req.params.id));
}));

router.post('/profiles/:id/entries', requireAuth, wrap(async (req, res) => {
  if (!(await store.getProfile(req.user.id, req.params.id))) {
    return res.status(404).json({ error: 'Profile not found.' });
  }

  const { date, weight, calories } = req.body;
  if (!date || weight == null || calories == null) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  const w = parseWeight(weight);
  const c = parseCalories(calories);
  if (!isValidDate(date) || w == null || c == null) {
    return res.status(400).json({ error: 'Invalid date, weight or calories.' });
  }

  try {
    res.status(201).json(await store.addEntry(req.params.id, { date, weight: w, calories: c }));
  } catch (err) {
    if (err instanceof store.ConflictError) return res.status(409).json({ error: err.message });
    throw err;
  }
}));

router.delete('/entries/:id', requireAuth, wrap(async (req, res) => {
  await store.deleteEntry(req.user.id, req.params.id);
  res.sendStatus(204);
}));

module.exports = router;
module.exports.validation = { isValidDate, parseWeight, parseCalories };
