const Anthropic = require('@anthropic-ai/sdk');
const { TOOLS, dispatchTool } = require('./tools');
const { MODEL, MAX_AGENT_ITERATIONS, MAX_TURN_OUTPUT_TOKENS } = require('../config');
const { emptyUsage, addUsage, computeCost } = require('../utils/cost');

function previewInput(input) {
  const json = JSON.stringify(input);
  if (json.length <= 140) return json;
  return json.slice(0, 137) + '...';
}

async function runAgentLoop({
  systemPrompt,
  userPrompt,
  ctx,
  maxIterations = MAX_AGENT_ITERATIONS,
  maxTokens = MAX_TURN_OUTPUT_TOKENS,
  costLimitUsd = null,
  onEvent = () => {}
}) {
  const client = new Anthropic();
  const messages = [{ role: 'user', content: userPrompt }];
  const usage = emptyUsage();
  const history = [];
  let finalSummary = null;
  let stopReason = null;
  let turn = 0;
  let aborted = null;

  for (turn = 1; turn <= maxIterations; turn++) {
    onEvent({ type: 'turn_start', turn });

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      tools: TOOLS,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages
    });

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
      onEvent({ type: 'tool_result', turn, name: call.name, ok: result.ok, error: result.error });

      history.push({ turn, kind: 'tool', name: call.name, input: call.input, result });

      toolResults.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: JSON.stringify(result),
        is_error: !result.ok
      });

      if (call.name === 'finish' && result.ok) {
        finalSummary = call.input.pr_summary;
      }
    }

    messages.push({ role: 'user', content: toolResults });

    if (finalSummary) {
      onEvent({ type: 'finished', turn, summary: finalSummary });
      break;
    }
  }

  if (!finalSummary && !aborted && turn > maxIterations) {
    onEvent({ type: 'iteration_limit', turn: maxIterations });
  }

  return { usage, history, finalSummary, completedTurns: turn, stopReason, aborted };
}

module.exports = { runAgentLoop };
