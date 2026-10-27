require('dotenv').config();
const express    = require('express');
const session    = require('express-session');
const path       = require('path');
const DynamoSessionStore = require('./session-store');
const passport   = require('./auth');
const api        = require('./api');

const app = express();

// Trust the reverse proxy (nginx on Elastic Beanstalk) so secure cookies work
app.set('trust proxy', 1);

// CloudFront reaches the instance over plain HTTP and reports the viewer's
// protocol in CloudFront-Forwarded-Proto. Only CloudFront can reach the
// instance (security group), so the header can be trusted.
app.use((req, res, next) => {
  if (req.get('CloudFront-Forwarded-Proto') === 'https') {
    req.headers['x-forwarded-proto'] = 'https';
  }
  next();
});

app.use(express.json());

// ── Health check ────────────────────────────────────────────────

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use(session({
  store: new DynamoSessionStore(),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  },
}));

app.use(passport.initialize());
app.use(passport.session());

// ── Auth routes ─────────────────────────────────────────────────

app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?auth=failed' }),
  (req, res) => res.redirect('/')
);

app.post('/auth/logout', (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    res.sendStatus(204);
  });
});

// ── API routes ──────────────────────────────────────────────────

app.use('/api', api);

// ── Static frontend ─────────────────────────────────────────────

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── Error handler ───────────────────────────────────────────────

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
