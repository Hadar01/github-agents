const Anthropic = require('@anthropic-ai/sdk');
const { TOOLS, dispatchTool } = require('./tools');
const { MODEL, MAX_AGENT_ITERATIONS, MAX_TURN_OUTPUT_TOKENS } = require('../config');
const { emptyUsage, addUsage, computeCost } = require('../utils/cost');

function previewInput(input) {
  const json = JSON.stringify(input);
  if (json.length <= 140) return json;
  return json.slice(0, 137) + '...';
}

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EPIPE'
]);

function isRetryable(err) {
  if (!err) return false;
  const status = err.status || (err.response && err.response.status);
  if (status === 429 || status === 529) return true;
  if (status >= 500 && status < 600) return true;
  const code = err.code || (err.cause && err.cause.code);
  if (code && RETRYABLE_NETWORK_CODES.has(code)) return true;
  return false;
}

async function callWithRetry(fn, {
  maxAttempts = 3,
  baseDelayMs = 1000,
  onRetry = () => {}
} = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === maxAttempts || !isRetryable(e)) throw e;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      onRetry({ attempt, nextAttempt: attempt + 1, delayMs: delay, error: e });
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function runAgentLoop({
  systemPrompt,
  userPrompt,
  ctx,
  maxIterations = MAX_AGENT_ITERATIONS,
  maxTokens = MAX_TURN_OUTPUT_TOKENS,
  costLimitUsd = null,
  onEvent = () => {},
  retryBaseDelayMs = 1000
}) {
  const client = new Anthropic();
  const messages = [{ role: 'user', content: userPrompt }];
  const usage = emptyUsage();
  const history = [];
  let finalSummary = null;
  let stopReason = null;
  let turn = 0;
  let aborted = null;
  let sawPassingTests = false; // flipped true when run_tests returns passed:true
  let sawPassingLint = null;   // null=not run, true=passed, false=last run failed
  let gaveUp = null;           // set when agent calls give_up

  for (turn = 1; turn <= maxIterations; turn++) {
    onEvent({ type: 'turn_start', turn });

    const response = await callWithRetry(
      () => client.messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        tools: TOOLS,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages
      }),
      {
        maxAttempts: 3,
        baseDelayMs: retryBaseDelayMs,
        onRetry: (info) => onEvent({ type: 'api_retry', turn, ...info })
      }
    );

    addUsage(usage, response.usage || {});
    stopReason = response.stop_reason;

    if (costLimitUsd !== null) {
      const { total_usd } = computeCost(usage);
      if (total_usd > costLimitUsd) {
        onEvent({ type: 'cost_limit_hit', turn, costUsd: total_usd, limit: costLimitUsd });
        aborted = 'cost_limit';
        stopReason = 'cost_limit';
        break;
      }
    }

    const textBlocks = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    const toolCalls = response.content.filter(b => b.type === 'tool_use');

    if (textBlocks) {
      onEvent({ type: 'thought', turn, text: textBlocks });
      history.push({ turn, kind: 'thought', text: textBlocks });
    }

    messages.push({ role: 'assistant', content: response.content });

    if (toolCalls.length === 0) {
      onEvent({ type: 'no_tools', turn, stop_reason: stopReason });
      break;
    }

    const toolResults = [];
    for (const call of toolCalls) {
      onEvent({ type: 'tool_call', turn, name: call.name, preview: previewInput(call.input) });
      const result = await dispatchTool(call.name, call.input, ctx);
      onEvent({
        type: 'tool_result', turn, name: call.name,
        ok: result.ok, error: result.error,
        flaky: result.flaky, attempts: result.attempts
      });

      history.push({ turn, kind: 'tool', name: call.name, input: call.input, result });

      if (call.name === 'run_tests' && result.ok && result.passed) {
        sawPassingTests = true;
      }
      if (call.name === 'run_lint' && result.ok) {
        sawPassingLint = result.passed;
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: JSON.stringify(result),
        is_error: !result.ok
      });

      if (call.name === 'finish' && result.ok) {
        finalSummary = call.input.pr_summary;
      }
      if (call.name === 'give_up' && result.ok) {
        gaveUp = {
          reason: result.reason,
          explanation: result.explanation,
          blockers: result.blockers
        };
        aborted = 'gave_up';
      }
    }

    messages.push({ role: 'user', content: toolResults });

    if (finalSummary) {
      onEvent({ type: 'finished', turn, summary: finalSummary });
      break;
    }
    if (gaveUp) {
      onEvent({ type: 'gave_up', turn, ...gaveUp });
      break;
    }
  }

  if (!finalSummary && !aborted && turn > maxIterations) {
    onEvent({ type: 'iteration_limit', turn: maxIterations });
  }

  return {
    usage, history, finalSummary,
    completedTurns: turn, stopReason, aborted,
    sawPassingTests, sawPassingLint, gaveUp
  };
}

module.exports = { runAgentLoop, callWithRetry, isRetryable };
