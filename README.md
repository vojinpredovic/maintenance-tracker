# Maintenance Tracker

A full stack web app that estimates your maintenance calories, the daily intake that keeps your weight stable, by fitting a regression line to your logged weight history and combining it with your calorie intake. Built for individuals and athletes who want a data-driven target instead of a generic formula.

---

## How it works

1. You log daily weigh-ins and calorie intake.
2. The app fits a **least-squares regression line** to your weight over time, giving a slope in **pounds per day**.
3. Using the standard **3,500 cal ≈ 1 lb** conversion, that slope becomes a daily energy balance:

   ```
   daily surplus/deficit (cal) = slope (lb/day) × 3500 (cal/lb)
   maintenance calories        = average daily intake − (slope × 3500)
   ```

   If you're trending up, you're eating above maintenance by that amount; if down, below it.
4. Because the estimate comes from a regression, the app also reports a **margin of error** derived from the uncertainty in the fitted slope, so you get a range rather than a single false-precision number.

The more days you log, the tighter that range gets.

## How to use

The app is deployed [here](https://maintenance-tracker-p2rd.onrender.com). It is moving from Render to AWS; this link will change once the move is done.

## Stack

- **Backend:** Node.js, Express, Passport (Google sign-in)
- **Database:** Amazon DynamoDB (single table; sessions included)
- **Hosting:** AWS Elastic Beanstalk behind CloudFront, secrets in Systems Manager Parameter Store
- **CI/CD:** GitHub Actions runs the tests against DynamoDB Local on every push and deploys `main` to Elastic Beanstalk

See [docs/aws-migration.md](docs/aws-migration.md) for the architecture, data model and deployment details.

## Local development

1. `npm install`
2. Sign in to AWS: `aws sso login`
3. Copy `.env.example` to `.env` and fill in the Google OAuth values and a `SESSION_SECRET`.
4. Create the dev table once: `npm run create-table -- maintenance-tracker-dev 5 5`
5. `npm run dev`, then open http://localhost:3000

Run the tests with `npm test`. They use the table in `TABLE_NAME` and clean up after themselves.

**Changing a production secret:** update it in Parameter Store, then refresh the Elastic Beanstalk environment so the new value is read. Beanstalk only reads parameters when an instance starts (see [docs/aws-migration.md](docs/aws-migration.md) §7).
