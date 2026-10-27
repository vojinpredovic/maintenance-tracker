const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isValidDate, parseWeight, parseCalories } = require('../server/api').validation;

test('isValidDate accepts real calendar dates only', () => {
  assert.ok(isValidDate('2026-10-27'));
  assert.ok(isValidDate('2024-02-29'));
  for (const bad of ['2026-02-30', '2026-13-01', '26-10-27', '2026-10-27T00:00', '', null, 20261027]) {
    assert.ok(!isValidDate(bad), String(bad));
  }
});

test('parseWeight accepts positive numbers and rounds to 2 decimals', () => {
  assert.equal(parseWeight(80), 80);
  assert.equal(parseWeight('79.456'), 79.46);
  for (const bad of [0, -1, 10000, 'abc', '', null, NaN, Infinity]) {
    assert.equal(parseWeight(bad), null, String(bad));
  }
});

test('parseCalories accepts positive integers only', () => {
  assert.equal(parseCalories(2500), 2500);
  assert.equal(parseCalories('2500'), 2500);
  for (const bad of [0, -5, 2500.5, 100000, 'abc', '', null]) {
    assert.equal(parseCalories(bad), null, String(bad));
  }
});
