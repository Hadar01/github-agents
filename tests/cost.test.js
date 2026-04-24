const { emptyUsage, addUsage, sumUsage, computeCost } = require('../src/utils/cost');
const {
  COST_INPUT_PER_MTOK,
  COST_OUTPUT_PER_MTOK,
  COST_CACHE_READ_PER_MTOK,
  COST_CACHE_CREATION_PER_MTOK
} = require('../src/config');

describe('cost utilities', () => {
  test('emptyUsage has all four counters zero', () => {
    expect(emptyUsage()).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    });
  });

  test('computeCost includes cache_creation_input_tokens', () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000
    };
    const cost = computeCost(usage);
    expect(cost.input_usd).toBeCloseTo(COST_INPUT_PER_MTOK, 6);
    expect(cost.output_usd).toBeCloseTo(COST_OUTPUT_PER_MTOK, 6);
    expect(cost.cache_read_usd).toBeCloseTo(COST_CACHE_READ_PER_MTOK, 6);
    expect(cost.cache_creation_usd).toBeCloseTo(COST_CACHE_CREATION_PER_MTOK, 6);
    expect(cost.total_usd).toBeCloseTo(
      COST_INPUT_PER_MTOK +
      COST_OUTPUT_PER_MTOK +
      COST_CACHE_READ_PER_MTOK +
      COST_CACHE_CREATION_PER_MTOK,
      6
    );
  });

  test('computeCost tolerates missing cache_creation field', () => {
    const cost = computeCost({
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_input_tokens: 0
    });
    expect(cost.cache_creation_usd).toBe(0);
    expect(cost.total_usd).toBeCloseTo(COST_INPUT_PER_MTOK, 6);
  });

  test('addUsage accumulates cache_creation_input_tokens', () => {
    const u = emptyUsage();
    addUsage(u, { cache_creation_input_tokens: 500 });
    addUsage(u, { cache_creation_input_tokens: 700 });
    expect(u.cache_creation_input_tokens).toBe(1200);
  });

  test('sumUsage tolerates nulls and unknown fields', () => {
    const u = sumUsage(null, { input_tokens: 10 }, undefined, { output_tokens: 20 });
    expect(u.input_tokens).toBe(10);
    expect(u.output_tokens).toBe(20);
  });
});
