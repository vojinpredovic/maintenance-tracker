const { Router } = require('express');
const pool = require('./db');

const router = Router();

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// ── Current user ────────────────────────────────────────────────

router.get('/me', requireAuth, (req, res) => {
  const { id, email, name } = req.user;
  res.json({ id, email, name });
});

// ── Profiles ────────────────────────────────────────────────────

router.get('/profiles', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.unit,
            COUNT(e.id)::int AS entry_count
     FROM profiles p
     LEFT JOIN entries e ON e.profile_id = p.id
     WHERE p.user_id = $1
     GROUP BY p.id
     ORDER BY p.created_at`,
    [req.user.id]
  );
  res.json(rows);
}));

router.post('/profiles', requireAuth, wrap(async (req, res) => {
  const { name, unit } = req.body;
  if (!name || !['kg', 'lbs'].includes(unit)) {
    return res.status(400).json({ error: 'Invalid name or unit.' });
  }

  const existing = await pool.query(
    'SELECT id FROM profiles WHERE user_id = $1 AND name = $2',
    [req.user.id, name]
  );
  if (existing.rows.length) {
    return res.status(409).json({ error: 'A profile with this name already exists.' });
  }

  const { rows } = await pool.query(
    'INSERT INTO profiles (user_id, name, unit) VALUES ($1, $2, $3) RETURNING id, name, unit',
    [req.user.id, name, unit]
  );
  res.status(201).json(rows[0]);
}));

router.delete('/profiles/:id', requireAuth, wrap(async (req, res) => {
  await pool.query(
    'DELETE FROM profiles WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  );
  res.sendStatus(204);
}));

// ── Entries ─────────────────────────────────────────────────────

router.get('/profiles/:id/entries', requireAuth, wrap(async (req, res) => {
  const prof = await pool.query(
    'SELECT id FROM profiles WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  );
  if (!prof.rows.length) return res.status(404).json({ error: 'Profile not found.' });

  const { rows } = await pool.query(
    'SELECT id, date, weight::float, calories FROM entries WHERE profile_id = $1 ORDER BY date',
    [req.params.id]
  );
  res.json(rows.map(r => ({ ...r, date: r.date.toISOString().slice(0, 10) })));
}));

router.post('/profiles/:id/entries', requireAuth, wrap(async (req, res) => {
  const prof = await pool.query(
    'SELECT id FROM profiles WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  );
  if (!prof.rows.length) return res.status(404).json({ error: 'Profile not found.' });

  const { date, weight, calories } = req.body;
  if (!date || weight == null || calories == null) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO entries (profile_id, date, weight, calories)
       VALUES ($1, $2, $3, $4)
       RETURNING id, date, weight::float, calories`,
      [req.params.id, date, weight, calories]
    );
    const entry = rows[0];
    res.status(201).json({ ...entry, date: entry.date.toISOString().slice(0, 10) });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An entry for this date already exists.' });
    }
    throw err;
  }
}));

router.delete('/entries/:id', requireAuth, wrap(async (req, res) => {
  await pool.query(
    `DELETE FROM entries
     WHERE id = $1
       AND profile_id IN (SELECT id FROM profiles WHERE user_id = $2)`,
    [req.params.id, req.user.id]
  );
  res.sendStatus(204);
}));

module.exports = router;
