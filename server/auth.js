const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const store = require('./store');

passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  process.env.CALLBACK_URL,
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const user = await store.upsertUser({
      id:    profile.id,
      email: profile.emails?.[0]?.value ?? null,
      name:  profile.displayName ?? null,
    });
    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));

passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
  try {
    done(null, (await store.getUser(id)) ?? false);
  } catch (err) {
    done(err);
  }
});

module.exports = passport;
