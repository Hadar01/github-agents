// Lightweight keyword-based file relevance scorer.
//
// The engineering agent previously had to explore big repos by grep-and-read
// alone, which wastes context and turns on Qiskit-class trees (thousands of
// files across multiple sub-packages). This module picks a shortlist of
// probably-relevant files given the issue text, using a fast local scorer —
// no embeddings, no extra API call.
//
// It is intentionally simple:
//  1. Tokenize the issue title + body (alphanumeric, lowercased, len >= 3,
//     with a small stopword set).
//  2. For every repo file, score:
//       path_score    — how many issue tokens appear in the file path
//                       (basename weighted 3x, dir components 1x)
//       content_score — how many issue tokens appear in the first 2 KB
//                       (weight 1 per occurrence, capped per token)
//  3. Return the top-K files by total score, ties broken by shorter paths
//     (so `src/auth/login.py` beats `tests/integration/auth/login_test.py`).
//
// This is a prefilter, not a selector: the agent is still free to explore.
// We give it a starting hint so it doesn't burn turn 1-5 on directory walks.

const fs = require('fs');
const path = require('path');

const STOPWORDS = new Set([
  'the','a','an','and','or','but','not','to','of','in','on','for','with',
  'is','was','were','be','been','being','are','am','do','does','did',
  'this','that','these','those','it','its','as','if','then','else','when',
  'at','by','from','into','out','up','down','over','under','than','so','too',
  'very','can','cannot','should','would','could','may','might','must','will',
  'shall','have','has','had','i','you','he','she','we','they','my','your',
  'his','her','our','their','me','him','us','them','error','bug','issue',
  'fix','fixes','fixed','broken','breaks','please','need','needs','want',
  'wants','make','add','remove','support','feature','problem'
]);

function tokenize(text) {
  if (!text) return new Set();
  const toks = String(text)
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
  return new Set(toks);
}

function scorePath(filePath, tokens) {
  const lower = filePath.toLowerCase();
  const base = path.basename(lower, path.extname(lower));
  const baseTokens = new Set(base.split(/[^a-z0-9]+/).filter(Boolean));
  const dirTokens = new Set(
    path.dirname(lower).split(/[\\/]+/).flatMap(p => p.split(/[^a-z0-9]+/)).filter(Boolean)
  );
  let score = 0;
  for (const tok of tokens) {
    if (baseTokens.has(tok)) score += 3;
    if (dirTokens.has(tok)) score += 1;
  }
  return score;
}

function scoreContent(absPath, tokens, budget = 2048) {
  let buf = '';
  try {
    const fd = fs.openSync(absPath, 'r');
    const b = Buffer.alloc(budget);
    const n = fs.readSync(fd, b, 0, budget, 0);
    fs.closeSync(fd);
    buf = b.slice(0, n).toString('utf8').toLowerCase();
  } catch {
    return 0;
  }
  let score = 0;
  for (const tok of tokens) {
    // A token that appears at all counts once; bursts cap at 3 to avoid
    // letting a doctest with the token 40 times dominate the ranking.
    const occurrences = (buf.match(new RegExp(`\\b${escapeRegex(tok)}\\b`, 'g')) || []).length;
    if (occurrences > 0) score += Math.min(3, occurrences);
  }
  return score;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rankFiles({ repoPath, files, issueText, topK = 30 }) {
  const tokens = tokenize(issueText);
  if (tokens.size === 0) {
    // Nothing to score against. Return a stable head slice.
    return files.slice(0, topK).map(f => ({ path: f, score: 0, pathScore: 0, contentScore: 0 }));
  }
  const scored = [];
  for (const rel of files) {
    const abs = path.join(repoPath, rel);
    const pScore = scorePath(rel, tokens);
    // Only pay the file-read cost for files that already look plausible on
    // path alone, or whose cheap path score is non-zero. This keeps the
    // scorer fast on 10k-file repos.
    const cScore = pScore > 0 ? scoreContent(abs, tokens) : 0;
    const total = pScore * 2 + cScore;
    if (total > 0) {
      scored.push({ path: rel, score: total, pathScore: pScore, contentScore: cScore });
    }
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.path.length - b.path.length;
  });
  return scored.slice(0, topK);
}

module.exports = { rankFiles, tokenize, scorePath, scoreContent };
