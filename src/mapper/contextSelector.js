const Anthropic = require('@anthropic-ai/sdk');
const { MODEL, MAX_RELEVANT_FILES } = require('../config');

const SELECTOR_SYSTEM = `You select the files from a repository that are most relevant to a given GitHub issue.

Rules:
- Return ONLY a JSON array of up to ${MAX_RELEVANT_FILES} file path strings.
- Paths must come verbatim from the provided repository file list.
- No prose, no commentary, no markdown fences.
- Pick fewer than ${MAX_RELEVANT_FILES} if only a few files are truly relevant.`;

function stripFences(text) {
  return String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

async function selectRelevantFiles(issueText, repoMap) {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [
      { type: 'text', text: SELECTOR_SYSTEM, cache_control: { type: 'ephemeral' } }
    ],
    messages: [
      {
        role: 'user',
        content: `Issue:\n${issueText}\n\nRepository file list:\n${repoMap.join('\n')}\n\nReturn a JSON array of up to ${MAX_RELEVANT_FILES} file paths most relevant to this issue.`
      }
    ]
  });

  const raw = response.content.map(b => b.text || '').join('');
  const cleaned = stripFences(raw);
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected a JSON array of file paths, got: ${typeof parsed}`);
  }
  return parsed.slice(0, MAX_RELEVANT_FILES);
}

module.exports = { selectRelevantFiles, stripFences };
