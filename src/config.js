module.exports = {
  MODEL: 'claude-sonnet-4-6',
  MAX_RELEVANT_FILES: 10,
  MAX_REVIEW_FILE_BYTES: 200_000,

  MAX_AGENT_ITERATIONS: 18,
  MAX_TURN_OUTPUT_TOKENS: 8192,
  MAX_REVISION_PASSES: 1,

  TEST_COMMAND_TIMEOUT_MS: 5 * 60 * 1000,
  TOOL_OUTPUT_TRUNCATE: 8000,

  // Cost per 1M tokens (USD) — for the audit trail summary line
  // Claude 3.5 Sonnet pricing; update here if rates change
  COST_INPUT_PER_MTOK: 3.0,
  COST_OUTPUT_PER_MTOK: 15.0,
  COST_CACHE_READ_PER_MTOK: 0.30,

  // Hard kill switch — abort an agent loop if its cost crosses this many USD.
  // Override per-run with --max-cost=X.XX
  DEFAULT_MAX_USD_PER_RUN: 5.0
};
