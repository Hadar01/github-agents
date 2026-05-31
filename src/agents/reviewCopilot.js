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

const INLINE_HEADING = /##\s*6\.?\s*Inline Comments[^\n]*\n/i;

// Pull the machine-readable findings out of the review's section 6. Returns a
// clean array of { file, line, severity, comment }. Defensive by construction:
// any malformed model output (no block, bad JSON, wrong shape) yields [] rather
// than throwing — a missing inline block must never break the review flow.
function parseInlineComments(text) {
  if (!text || typeof text !== 'string') return [];

  // Prefer the json block that follows the section-6 heading; fall back to the
  // last json block in the document if the heading drifted.
  const headingMatch = text.match(INLINE_HEADING);
  const scope = headingMatch
    ? text.slice(headingMatch.index + headingMatch[0].length)
    : text;
  const fence = /```json\s*\n([\s\S]*?)```/gi;
  let raw = null;
  let m;
  while ((m = fence.exec(scope)) !== null) raw = m[1]; // keep the last match
  if (raw === null) return [];

  let parsed;
  try { parsed = JSON.parse(raw.trim()); } catch { return []; }
  if (!Array.isArray(parsed)) return [];

  const out = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const file = typeof item.file === 'string' ? item.file.trim() : '';
    const line = Number.isInteger(item.line) ? item.line : parseInt(item.line, 10);
    const comment = typeof item.comment === 'string' ? item.comment.trim() : '';
    if (!file || !Number.isInteger(line) || line <= 0 || !comment) continue;
    const severity = item.severity === 'blocking' ? 'blocking' : 'nit';
    out.push({ file, line, severity, comment });
  }
  return out;
}

// Remove the machine-readable section 6 from the human-facing report so a
// reviewer reading review-report.md / the PR body never sees raw JSON.
function stripInlineCommentsBlock(text) {
  if (!text || typeof text !== 'string') return text;
  const headingMatch = text.match(INLINE_HEADING);
  if (headingMatch) return text.slice(0, headingMatch.index).trimEnd() + '\n';
  // No heading — strip a trailing json fence if one is present.
  return text.replace(/```json\s*\n[\s\S]*?```\s*$/i, '').trimEnd() + '\n';
}

module.exports = { runReviewCopilot, parseInlineComments, stripInlineCommentsBlock };
