# Maintenance Tracker

An AI-assisted web app that estimates your maintenance calories, the daily intake that keeps your weight stable, by fitting a regression line to your logged weight history and combining it with your calorie intake. Built for individuals and athletes who want a data-driven target instead of a generic formula.

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

The app is deployed [here](https://maintenance-tracker-p2rd.onrender.com) using Render.
