const { computeCost } = require('../utils/cost');

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m'
};

function banner() {
  return `${c.cyan}${c.bold}
   ╔════════════════════════════════════════════╗
   ║   github-agent — autonomous PR engineer    ║
   ║   engineering → self-review → ship         ║
   ╚════════════════════════════════════════════╝${c.reset}`;
}

function step(label) {
  return `\n${c.bold}${c.blue}▸ ${label}${c.reset}`;
}

function info(text) {
  return `${c.dim}  ${text}${c.reset}`;
}

function ok(text) {
  return `${c.green}  ✓ ${text}${c.reset}`;
}

function warn(text) {
  return `${c.yellow}  ⚠ ${text}${c.reset}`;
}

function err(text) {
  return `${c.red}  ✗ ${text}${c.reset}`;
}

function tool(name, preview) {
  return `${c.dim}  🔧 ${c.reset}${c.magenta}${name}${c.reset}${c.dim}${preview ? '(' + preview + ')' : ''}${c.reset}`;
}

function thought(turn, text) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const trimmed = oneLine.length > 200 ? oneLine.slice(0, 197) + '...' : oneLine;
  return `${c.dim}  💭 [turn ${turn}] ${trimmed}${c.reset}`;
}

function usageSummary(label, usage) {
  const cost = computeCost(usage);
  return `${c.bold}${label}${c.reset}\n` +
    `  input: ${usage.input_tokens.toLocaleString()} tok` +
    `  · output: ${usage.output_tokens.toLocaleString()} tok` +
    `  · cache_read: ${usage.cache_read_input_tokens.toLocaleString()} tok\n` +
    `  ${c.green}cost: $${cost.total_usd.toFixed(4)}${c.reset}` +
    ` ${c.dim}(in $${cost.input_usd.toFixed(4)} + out $${cost.output_usd.toFixed(4)} + cache $${cost.cache_read_usd.toFixed(4)})${c.reset}`;
}

function makeAgentEventHandler(log) {
  return (e) => {
    if (e.type === 'turn_start') {
      // Quiet — don't spam. The thoughts/tools will print.
      return;
    }
    if (e.type === 'thought') {
      log(thought(e.turn, e.text));
      return;
    }
    if (e.type === 'tool_call') {
      log(tool(e.name, e.preview));
      return;
    }
    if (e.type === 'tool_result') {
      if (e.ok) log(`${c.dim}     → ok${c.reset}`);
      else log(err(`     → ${e.error}`));
      return;
    }
    if (e.type === 'finished') {
      log(ok(`Agent finished after ${e.turn} turn(s)`));
      return;
    }
    if (e.type === 'iteration_limit') {
      log(warn(`Agent hit iteration limit (${e.turn})`));
      return;
    }
    if (e.type === 'no_tools') {
      log(warn(`Agent stopped without calling finish (stop_reason=${e.stop_reason})`));
      return;
    }
    if (e.type === 'cost_limit_hit') {
      log(err(`Cost limit hit at turn ${e.turn}: $${e.costUsd.toFixed(4)} > $${e.limit}`));
      return;
    }
  };
}

function makeStageEventHandler(log) {
  return (e) => {
    if (e.stage === 'engineering_start') log(step('Engineering agent — autonomous fix loop'));
    else if (e.stage === 'engineering_aborted') log(err('Engineering agent did not complete'));
    else if (e.stage === 'no_diff') log(warn('Agent finished but produced no diff'));
    else if (e.stage === 'self_review_start') log(step('Self-review — auditing the diff'));
    else if (e.stage === 'self_review_done') log(ok(`Review verdict: ${e.verdict}`));
    else if (e.stage === 'revision_start') log(step('Revision pass — addressing review feedback'));
    else if (e.stage === 'revision_done') log(ok('Revision complete'));
  };
}

module.exports = {
  banner,
  step,
  info,
  ok,
  warn,
  err,
  tool,
  thought,
  usageSummary,
  computeCost,
  makeAgentEventHandler,
  makeStageEventHandler,
  c
};
