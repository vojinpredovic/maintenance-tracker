# Spec: Move Maintenance Tracker from Render to AWS

| | |
|---|---|
| Status | Draft, awaiting review |
| Author | Vojin Predovic |
| Last updated | 2026-10-27 |

## 1. Summary

Move the app off Render and onto AWS, and replace Postgres with DynamoDB:

- **Compute:** Elastic Beanstalk (Node.js platform, single instance)
- **Database:** Amazon DynamoDB, one table
- **Config and secrets:** Systems Manager Parameter Store
- **HTTPS:** CloudFront in front of Beanstalk
- **Deploys:** GitHub Actions on every push to `main`

The AWS version starts with an empty database. Existing Render data is **not** migrated. Render keeps running until the AWS version is verified, and is shut down after that.

## 2. Goals and non-goals

**Goals**
- Same features and behavior as today: Google login, profiles, entries, maintenance estimate.
- **The HTTP API and frontend stay unchanged.** Same routes, same request and response shapes. Only the data layer behind them changes.
- Served over HTTPS.
- No secrets in the repo, in GitHub, or in Beanstalk config as plain text.
- A push to `main` deploys automatically, and a failed deploy leaves the running version in place.
- Low monthly cost. Target: about $10/month once AWS credits run out.

**Non-goals**
- Migrating existing Render data.
- High availability or autoscaling. A single instance is fine for a personal app.
- A custom domain. This is optional and comes later (§11).
- Frontend or feature changes.

## 3. Current state

- One Express service (`server/index.js`) serves the API, the Google OAuth login (Passport) and the static frontend `public/index.html`. The regression and maintenance estimate are calculated in the browser.
- Postgres stores `users`, `profiles` and `entries`. It also stores login sessions in a `session` table via `connect-pg-simple`. The server keeps no state of its own.
- Postgres currently does several jobs implicitly that the new data layer must do explicitly:
  - Rejects invalid dates and numbers (`DATE`, `NUMERIC(6,2)`, `INTEGER` columns).
  - Enforces one entry per profile per day (`UNIQUE (profile_id, date)`).
  - Deletes a profile's entries when the profile is deleted (`ON DELETE CASCADE`).
  - Counts entries per profile (`LEFT JOIN … COUNT`).
- Configuration comes from env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CALLBACK_URL`, `DATABASE_URL`, `SESSION_SECRET`, `NODE_ENV` and `PORT`.
- Deployment is set up in Render's dashboard. The repo has no infrastructure files, and `server/schema.sql` was applied by hand.

## 4. Target architecture

```
Browser ──HTTPS──▶ CloudFront (https://<id>.cloudfront.net)
                        │  HTTP, port 80
                        ▼
              Elastic Beanstalk instance (EC2 t4g.micro, Amazon Linux 2023)
              nginx ──▶ Node app (PORT=8080)
                        │  HTTPS (AWS SDK), authorized by the instance's IAM role
                        ▼
              DynamoDB table "maintenance-tracker" (provisioned capacity)

Parameter Store ──(read at instance boot)──▶ Beanstalk environment variables
GitHub Actions ──(OIDC role)──▶ S3 app bundle ──▶ Beanstalk new application version
```

### Why CloudFront
A single-instance Beanstalk environment has no load balancer, so its `*.elasticbeanstalk.com` URL is **HTTP only**. Three things need HTTPS:
- Google OAuth only allows `https://` redirect URIs (except `localhost`).
- The session cookie is `secure` in production, so browsers won't send it over HTTP.
- Health and fitness data should be encrypted in transit anyway.

AWS's free certificates (ACM) can't be attached to a single instance. The alternatives are a load balancer (about $16+/month, and it still needs a custom domain for the certificate) or running Let's Encrypt on the instance (lost whenever the instance is replaced). CloudFront gives a free HTTPS URL (`<id>.cloudfront.net`) and costs little at this traffic. It is also where a custom domain would be added later.

### Why DynamoDB
- **Every access pattern is scoped to one user or one profile.** That's exactly what DynamoDB's key lookups and range queries handle.
- **It's free at this scale.** The always-free tier covers 25 GB of storage and 25 read/write capacity units of provisioned throughput, saving about $14.5/month compared with RDS.
- **No database networking, connection pool, password or certificate bundle.** Access goes through IAM.
- **The app starts with an empty database,** so there is no data to convert.

The trade-off is giving up ad-hoc SQL queries. That's acceptable because the app's analysis happens in the browser on one profile's entries.

### Components

| Component | Choice | Notes |
|---|---|---|
| Region | `us-east-2` (Ohio) | Same region as the account's IAM Identity Center. Everything stays in one region. |
| Beanstalk platform | Node.js 22 on Amazon Linux 2023, newest platform version | The platform must be released on or after 2025-03-26 for Parameter Store env vars. Pin `"engines": {"node": "22.x"}` in `package.json`. |
| Beanstalk environment | Web server, **single instance**, `t4g.micro` (ARM) | All dependencies are pure JS, so ARM is fine. Uses the default VPC. |
| DynamoDB table | `maintenance-tracker`, keys `pk` (String) + `sk` (String) | **Provisioned** capacity, 10 RCU / 10 WCU, no auto scaling. On-demand mode isn't covered by the always-free tier. |
| Table protection | Deletion protection on, point-in-time recovery (PITR) on | PITR costs cents per month at this data size. |
| Session expiry | DynamoDB TTL on attribute `expiresAt` | Removes expired sessions automatically. |
| Secrets | Parameter Store, `SecureString` (default AWS-managed KMS key) | Standard parameters are free. |
| CDN/HTTPS | CloudFront, managed policies `CachingDisabled` + `AllViewerExceptHostHeader` | No caching at all. The app is small and caching authenticated API responses is risky. Cookies, query strings and headers are all forwarded. |
| Origin lockdown | Instance security group allows port 80 only from CloudFront's managed prefix list `com.amazonaws.global.cloudfront.origin-facing` | Blocks direct HTTP access to the instance and spoofed protocol headers (§6.3). |
| CI/CD | GitHub Actions, AWS access through OIDC | No long-lived AWS keys stored in GitHub. |

The free tier's 25 RCU/WCU is shared across all tables in the account. Prod (10/10) plus a dev table (5/5, §6.6) uses 15/15, leaving headroom.

## 5. Data model (single table)

Table `maintenance-tracker`. All attribute names are camelCase. API responses keep their current snake_case field (`entry_count`).

| Item | `pk` | `sk` | Other attributes |
|---|---|---|---|
| User | `USER#<googleId>` | `META` | `email`, `name`, `createdAt` |
| Profile | `USER#<googleId>` | `PROFILE#<profileId>` | `profileId`, `name`, `unit` (`kg`/`lbs`), `createdAt` |
| Profile name guard | `USER#<googleId>` | `PROFILENAME#<name>` | `profileId` |
| Entry | `PROFILE#<profileId>` | `ENTRY#<yyyy-mm-dd>` | `weight` (Number), `calories` (Number), `createdAt` |
| Session | `SESSION#<sid>` | `META` | `sess` (JSON string), `expiresAt` (epoch seconds, TTL) |

**IDs**
- **User ID** is the Google account ID (`profile.id` from Passport), replacing the `SERIAL` id. That means no lookup is needed at login, and it's what `serializeUser` stores in the session.
- **Profile ID** is `crypto.randomUUID()`.
- **Entry ID** in the API is `<profileId>_<date>`, e.g. `3f2a…-9c1e_2026-10-27`. UUIDs never contain `_`. This keeps `DELETE /api/entries/:id` unchanged even though an entry's key needs both parts.
- The frontend treats IDs as opaque strings in URLs, so switching from numbers to strings needs no frontend change.

**Access patterns**

| Route | DynamoDB operations |
|---|---|
| Login (Passport verify) | `PutItem` user (upsert of email/name, `createdAt` kept via `if_not_exists`) |
| `deserializeUser` | `GetItem` `USER#<id>`/`META` |
| `GET /api/profiles` | `Query` `pk = USER#<id>`, `begins_with(sk, "PROFILE#")`. Then, for each profile in parallel, `Query` `pk = PROFILE#<pid>` with `Select: COUNT` (following `LastEvaluatedKey`). Sort by `createdAt` in code. |
| `POST /api/profiles` | `TransactWriteItems`: put profile + put name guard with `attribute_not_exists(pk)`. A failed condition returns **409** "A profile with this name already exists." |
| `DELETE /api/profiles/:id` | `GetItem` the profile (ownership check, 204 if missing to match today). Then `TransactWriteItems` to delete the profile + name guard. Then `Query` the entry keys and `BatchWriteItem` delete in chunks of 25, retrying `UnprocessedItems`. |
| `GET /api/profiles/:id/entries` | Ownership `GetItem` (404 if missing), then `Query` `pk = PROFILE#<pid>`. The sort key already returns entries by date. |
| `POST /api/profiles/:id/entries` | Ownership `GetItem`, then `PutItem` with `attribute_not_exists(sk)`. A failed condition returns **409** "An entry for this date already exists." |
| `DELETE /api/entries/:id` | Parse `<profileId>_<date>`, ownership `GetItem`, then `DeleteItem`. 204 either way, matching today. |

**Design decisions**
- **Entry counts are computed with a `COUNT` query, not a stored counter.** A counter needs a transaction on every add or delete and can drift. A count query is always correct and cheap: entries are about 100 bytes, so even 1,000 entries read about 13 RCU.
- **Profile deletion order:** profile first, then entries. If the process dies in between, leftover entries can't be seen or reached by anyone (their profile is gone). The reverse order could leave a visible profile with some of its entries missing.
- **Profile name uniqueness** stays exact-match, as it is today.

**Validation moves into the API**

Postgres rejected bad input; DynamoDB stores whatever it's given. `api.js` must now check:
- `date` matches `YYYY-MM-DD` and is a real calendar date.
- `weight` is a finite number, `0 < weight < 10000`, stored rounded to 2 decimals.
- `calories` is an integer, `0 < calories < 100000`.
- Profile `name` is a non-empty string of at most 40 characters after trimming (the frontend's `maxlength`), and `unit` is `kg` or `lbs`.

Invalid input returns **400** with the existing error message style.

## 6. Application changes

All in this repo, delivered as one PR before any AWS setup.

### 6.1 Data layer
- **Dependencies:** remove `pg` and `connect-pg-simple`. Add `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` (Document client).
- **`server/db.js`:** exports a configured `DynamoDBDocumentClient` and the table name (`TABLE_NAME` env var). If `DYNAMODB_ENDPOINT` is set, it points there, for DynamoDB Local in CI. On Beanstalk, credentials come from the instance role automatically.
- **New `server/store.js`:** one function per access pattern in §5 (`upsertUser`, `getUser`, `listProfiles`, `createProfile`, `deleteProfile`, `listEntries`, `addEntry`, `deleteEntry`), including the entry ID encoding. It throws `ConflictError` for duplicates, which the routes map to 409. Missing or not-owned profiles come back as `null`, which the routes map to 404 where today's API does.
- **`server/auth.js` and `server/api.js`:** replace the SQL with `store.js` calls. Routes, status codes and response shapes stay the same.
- **Delete `server/schema.sql`.** Its replacement is the table definition in §6.5.

### 6.2 Session store
Add `server/session-store.js`: a small `express-session` `Store` subclass with `get`, `set`, `destroy` and `touch` on the `SESSION#<sid>` items.
- `expiresAt` comes from the cookie's expiry (30 days).
- `get` treats an item past `expiresAt` as missing, because DynamoDB's TTL can take up to a couple of days to actually delete expired items.

This is about 50 lines and avoids depending on a third-party DynamoDB session package.

### 6.3 HTTPS detection behind CloudFront (`server/index.js`)
The request path is CloudFront → nginx → Node. CloudFront talks to the instance over HTTP, so Express can't tell from the connection that the user is on HTTPS. Without fixing this, `express-session` won't set the `secure` cookie and login silently fails.
- Add the `CloudFront-Forwarded-Proto` header to CloudFront's origin request policy. `AllViewerExceptHostHeader` already includes CloudFront headers. Confirm this in Phase 3.
- Before the session middleware, add middleware that treats the request as HTTPS when `CloudFront-Forwarded-Proto: https` is present. For example, set `req.headers['x-forwarded-proto'] = 'https'` while `trust proxy` stays enabled.
- This is only safe because the security group accepts traffic from CloudFront alone (§4).
- Update the `trust proxy` comment, which still refers to Render.

### 6.4 Health check
Add `GET /healthz`. It returns `200 {"ok": true}` without touching the database or requiring login, and is registered before the `*` catch-all route. Beanstalk health monitoring and the deploy workflow's smoke test (§8) both use it.

### 6.5 Table definition
Add `scripts/create-table.js` (`npm run create-table -- <name> <rcu> <wcu>`). It creates the table with the keys from §5, enables TTL on `expiresAt`, and turns on PITR and deletion protection. Against DynamoDB Local (CI), it skips TTL, PITR and deletion protection. If the table already exists, it does nothing.

This one script creates the prod table, the dev table and the CI table, so they can't drift apart.

### 6.6 Local development and tests
- **Local dev uses a separate AWS table** `maintenance-tracker-dev` (5/5 capacity), reached through your AWS CLI login. This avoids installing Docker. `.env` sets `TABLE_NAME=maintenance-tracker-dev`, and `.env.example` documents it, removes `DATABASE_URL`, and adds `TABLE_NAME`, `AWS_REGION` and the optional `DYNAMODB_ENDPOINT`.
- **Add tests with Node's built-in runner** (`node --test`, `npm test`) for `store.js`. They're new because the data layer is being rewritten and SQL constraints no longer protect it. They cover:
  - Each access pattern.
  - Duplicate profile name and duplicate entry date returning 409.
  - A profile delete removing all its entries, including more than 25.
  - Validation rejects.
  - Session expiry.
- Tests run against whatever `TABLE_NAME`/`DYNAMODB_ENDPOINT` points to. Each test run uses a fresh `test-<random>` user ID, so it never touches other data.

### 6.7 Beanstalk config in the repo
- `.ebextensions/01-env.config` sets `NODE_ENV=production`, `TABLE_NAME=maintenance-tracker` and `AWS_REGION`, and turns on CloudWatch log streaming (7-day retention).
- **Secrets aren't mapped in the repo.** The repo is public, and the Parameter Store ARNs contain the account ID. The mapping (`aws:elasticbeanstalk:application:environmentsecrets` namespace, §7) is set on the environment itself in Phase 3.
- **The source bundle is an explicit list:** `git archive` of `server/`, `public/`, `package.json`, `package-lock.json` and `.ebextensions/`. Untracked files like `.env` and `node_modules/` can never end up in it, so no `.ebignore` is needed.
- Beanstalk runs `npm install --omit=dev` on the instance, so `package-lock.json` must stay committed.

### 6.8 Cleanup
- Update the README: the deployed URL, a short "Deployment" section pointing to this doc, the local dev setup, and remove the Render mention.
- Delete the root `index.html`. It's an older version that saves to browser storage (`localStorage`) and isn't served by the app.

## 7. Configuration and secrets

Parameter Store, all under the prefix `/maintenance-tracker/prod/`:

| Parameter | Type | Value |
|---|---|---|
| `SESSION_SECRET` | SecureString | New random 64-byte value. Not reused from Render. |
| `GOOGLE_CLIENT_ID` | String | From the Google Cloud OAuth client |
| `GOOGLE_CLIENT_SECRET` | SecureString | New secret. Not reused from Render. |
| `CALLBACK_URL` | String | `https://<id>.cloudfront.net/auth/google/callback` |

`NODE_ENV`, `TABLE_NAME` and `AWS_REGION` aren't secret, so they're set in `.ebextensions`. Beanstalk sets `PORT=8080` itself. `DATABASE_URL` no longer exists.

**Instance permissions:** Beanstalk's instance role (`aws-elasticbeanstalk-ec2-role`) gets one inline policy with two parts:
- **SSM:** `ssm:GetParameter(s)` on `arn:aws:ssm:<region>:<account>:parameter/maintenance-tracker/prod/*`, plus `kms:Decrypt` through the SSM key.
- **DynamoDB:** `GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, `Query`, `BatchWriteItem` and `ConditionCheckItem` on the `maintenance-tracker` table ARN only. No `Scan` and no table-management actions.

**Changing a value:** Beanstalk reads parameters only at instance boot. After changing one, refresh the environment so the new value is picked up.

## 8. CI/CD: GitHub Actions

Workflow `.github/workflows/deploy.yml`:

1. **Trigger:** push to `main` and pull requests (test job only), plus manual `workflow_dispatch`.
2. **Test job:**
   - `npm ci`.
   - Start DynamoDB Local as a service container (`amazon/dynamodb-local`), which needs no AWS access.
   - Run `npm run create-table` against it, then `npm test`.
3. **Deploy job:** only on `main`, only after tests pass, and only when the repository variable `DEPLOY_ENABLED` is `true` (set in Phase 4). Settings come from repository variables: `AWS_DEPLOY_ROLE_ARN`, `EB_APPLICATION`, `EB_ENVIRONMENT`, `EB_BUCKET` and `APP_URL`.
   1. Build the source bundle (§6.7). The version label is `git-<sha>-<run id>-<attempt>`, so re-running an old commit's workflow (a rollback) never collides with an existing label.
   2. `aws-actions/configure-aws-credentials` assumes an IAM role through GitHub OIDC. The role's trust policy accepts only `repo:vojinpredovic/maintenance-tracker:ref:refs/heads/main`.
   3. Upload the zip to the Beanstalk S3 bucket, run `create-application-version`, then `update-environment`, then wait until the environment is `Ready`.
   4. **Smoke test:** `curl` `https://<cloudfront>/healthz` expecting 200. If it fails, the job fails.

**Deploy role permissions:** scoped to this application and environment: Beanstalk create/update/describe, S3 put on the Beanstalk bucket, and the CloudFormation/EC2/Auto Scaling read actions Beanstalk needs during an update. Start from AWS's managed `AdministratorAccess-AWSElasticBeanstalk` policy and tighten it after the first successful deploy. The deploy role has **no** DynamoDB data access.

**Failure behavior:** Beanstalk deploys to a single instance replace the app in place. If the new version doesn't start, Beanstalk marks the environment as degraded. To roll back, redeploy the previous version label from the console, or re-run the workflow on an earlier commit.

## 9. Implementation plan

Each phase ends with a checkpoint before the next one starts. Steps marked **(you)** need the AWS or Google console and can't be done from code.

**Phase 0: AWS account setup (you, about 30–45 min)**
- Turn on MFA for the root user, then stop using root.
- Create an admin user through IAM Identity Center and sign in as that user from then on.
- Create an AWS Budget with an email alert at $5 and $15/month.
- Check whether the account is on the free plan or the paid plan, and when the credits expire.
- Install the AWS CLI (`brew install awscli`) and run `aws configure sso`. Use `us-east-2` for both the SSO region and the default region.
- ✅ Checkpoint: `aws sts get-caller-identity` works as the admin user.

**Phase 1: Code changes (Claude, one PR)**
- Everything in §6, plus the workflow from §8, with the deploy job turned off until Phase 4.
- Create the dev table with `npm run create-table`, then run `npm test` against it.
- Test the app by hand locally: login, create a profile, a duplicate name, add entries, a duplicate date, delete an entry, delete a profile, `/healthz`.
- ✅ Checkpoint: PR reviewed and merged, with CI tests green on DynamoDB Local. Render still serves production, unaffected.

**Phase 2: Table and secrets**
- Create the prod table with `npm run create-table -- maintenance-tracker 10 10`.
- Check in the console that TTL, PITR and deletion protection are all on.
- Create the Parameter Store parameters (§7), filling `CALLBACK_URL` in Phase 3.
- ✅ Checkpoint: the table is `ACTIVE`, and the parameters exist with the right types.

**Phase 3: Beanstalk + CloudFront**
- Create the Beanstalk application and single-instance environment. Attach the instance-role policy from §7.
- Map the Parameter Store parameters to env vars on the environment (`environmentsecrets` namespace, §6.7).
- Create the CloudFront distribution pointing at the environment's URL. Restrict the instance security group to the CloudFront prefix list.
- Set `CALLBACK_URL` and refresh the environment.
- **(you)** In Google Cloud Console, create a new OAuth client secret and add `https://<id>.cloudfront.net/auth/google/callback` as an authorized redirect URI. Keep the Render URI for now.
- Do the first deploy by hand with the Phase 1 build.
- ✅ Checkpoint: acceptance criteria (§10) pass on the CloudFront URL.

**Phase 4: Automated deploys**
- Create the GitHub OIDC provider and deploy role in IAM, and add the role ARN as a GitHub Actions variable (not a secret; it isn't sensitive).
- Turn on the deploy job. Push a trivial change and confirm it deploys and passes the smoke test.
- ✅ Checkpoint: a push to `main` deploys with no manual steps.

**Phase 5: Switch over and shut down Render**
- Update the README link and announce the new URL to any users.
- After about a week without problems:
  - Delete the Render web service and Render Postgres.
  - Remove the Render redirect URI and the old client secret in Google Cloud Console.
  - Remove the Render env vars.
- ✅ Checkpoint: Render costs $0, and only AWS URLs remain.

## 10. Acceptance criteria

- [ ] `https://<id>.cloudfront.net` loads the app. Plain `http://` redirects to HTTPS (CloudFront viewer protocol policy "Redirect HTTP to HTTPS").
- [ ] Google login works end to end, and the session cookie is set with `Secure` and `HttpOnly`.
- [ ] Profiles and entries can be created, listed and deleted, and the profile list shows correct entry counts. The maintenance estimate renders.
- [ ] Duplicate profile names and duplicate entry dates return 409 with the existing messages. Invalid dates and numbers return 400.
- [ ] Deleting a profile removes all its entries (check in the DynamoDB console).
- [ ] The session survives an app restart (`eb restart` or redeploy), which proves sessions live in DynamoDB.
- [ ] After logging out, the old session cookie no longer authenticates. Passport replaces the session with an empty one, which TTL removes later.
- [ ] Direct HTTP to the instance's own address is refused.
- [ ] The instance role can't `Scan` or reach any other table.
- [ ] No secret values appear in the repo, in GitHub Actions logs, or in Beanstalk's plain-text env config.
- [ ] A push to `main` runs tests, deploys automatically, and `/healthz` returns 200 afterwards.
- [ ] Logs from the app are visible in CloudWatch Logs (turn on Beanstalk log streaming, 7-day retention).

## 11. Later (out of scope)

- **Custom domain:** register it (e.g. in Route 53, about $15/year), request an ACM certificate in `us-east-1` for CloudFront, and add the domain as a CloudFront alternate name. Update `CALLBACK_URL` and the Google redirect URI.
- Infrastructure as code (CDK or Terraform) to replace the console setup.
- Data export (e.g. a CSV download per profile), which is easier to build now that entries are keyed by profile.

## 12. Cost estimate

Approximate on-demand prices for `us-east-2`. Verify with the AWS Pricing Calculator before Phase 2. New accounts (since July 2025) get up to $200 in credits, which should cover well over a year at this cost.

| Item | ~ $/month |
|---|---|
| EC2 `t4g.micro` (Beanstalk instance) | 6 |
| Public IPv4 address for the instance | 3.6 |
| DynamoDB storage and provisioned capacity (within always-free tier) | 0 |
| DynamoDB PITR | < 0.05 |
| CloudFront, Parameter Store (standard), CloudWatch Logs at this traffic | ~0–1 |
| **Total** | **~$10** |

## 13. Risks and open questions

| Risk / question | Mitigation |
|---|---|
| Express doesn't see HTTPS behind CloudFront, so login fails silently. | §6.3 middleware. Acceptance check on the `Secure` cookie. Test this first in Phase 3. |
| Someone bypasses CloudFront and sends a spoofed protocol header. | Security group allows only CloudFront's prefix list. |
| Replacing the instance changes its public address, and CloudFront's origin is the Beanstalk URL. | Point CloudFront at the environment's CNAME (`*.elasticbeanstalk.com`), not an IP. It follows the instance. |
| Bad input gets stored because Postgres no longer validates it. | Explicit validation in `api.js` (§5), covered by tests. |
| A profile delete is interrupted, leaving orphaned entries. | Deletion order (§5) makes orphans unreachable. Acceptable for a personal app. |
| Traffic exceeds the provisioned capacity, causing throttling errors. | 10 RCU/WCU is far above expected traffic for a personal app. The SDK retries throttled calls. Raise capacity if CloudWatch shows throttles. |
| Someone adds a table with on-demand mode or extra capacity, going over the free tier. | §4 notes the shared 25/25 limit. The budget alert catches surprises. |
| Parameter Store values change but the app keeps old ones. | Refresh the environment after any parameter change (§7). Document it in the README deployment section. |
| Accidental table deletion. | Deletion protection on, PITR on, and the deploy role has no DynamoDB access. |
| The free-plan account closes when credits run out. | Check the plan type in Phase 0. Upgrade to a paid plan before credits expire if the app should keep running. |
