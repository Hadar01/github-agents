const {
  COST_INPUT_PER_MTOK,
  COST_OUTPUT_PER_MTOK,
  COST_CACHE_READ_PER_MTOK,
  COST_CACHE_CREATION_PER_MTOK
} = require('../config');

function emptyUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0
  };
}

function addUsage(into, delta) {
  into.input_tokens += delta.input_tokens || 0;
  into.output_tokens += delta.output_tokens || 0;
  into.cache_read_input_tokens += delta.cache_read_input_tokens || 0;
  into.cache_creation_input_tokens += delta.cache_creation_input_tokens || 0;
  return into;
}

function sumUsage(...usages) {
  const total = emptyUsage();
  for (const u of usages) {
    if (u) addUsage(total, u);
  }
  return total;
}

function computeCost(usage) {
  const inputCost = (usage.input_tokens / 1_000_000) * COST_INPUT_PER_MTOK;
  const outputCost = (usage.output_tokens / 1_000_000) * COST_OUTPUT_PER_MTOK;
  const cacheReadCost = (usage.cache_read_input_tokens / 1_000_000) * COST_CACHE_READ_PER_MTOK;
  const cacheCreationCost = ((usage.cache_creation_input_tokens || 0) / 1_000_000) * COST_CACHE_CREATION_PER_MTOK;
  return {
    input_usd: inputCost,
    output_usd: outputCost,
    cache_read_usd: cacheReadCost,
    cache_creation_usd: cacheCreationCost,
    total_usd: inputCost + outputCost + cacheReadCost + cacheCreationCost
  };
}

module.exports = { emptyUsage, addUsage, sumUsage, computeCost };
