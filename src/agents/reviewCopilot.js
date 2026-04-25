const Anthropic = require('@anthropic-ai/sdk');
const { REVIEW_SYSTEM_PROMPT, buildReviewPrompt } = require('../prompts/review');
const { MODEL } = require('../config');

async function runReviewCopilot({ pr, diff, fileMap, issueTitle, issueBody }) {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: [
      { type: 'text', text: REVIEW_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }
    ],
    messages: [
      {
        role: 'user',
        content: buildReviewPrompt({
          prTitle: pr.title,
          prBody: pr.body || '',
          diff,
          fileMap,
          issueTitle,
          issueBody
        })
      }
    ]
  });

  return response.content.map(b => b.text || '').join('\n');
}

module.exports = { runReviewCopilot };
