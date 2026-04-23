const REVIEW_SYSTEM_PROMPT = `You are a senior code reviewer.

Your operating principles:
- Audit, do not rubber-stamp. Every PR has tradeoffs. Surface them.
- Ground every concern in specific lines of the diff. Cite file:line.
- Distinguish blocking issues from nits. Use the verdict to signal severity.
- Consider what the diff does NOT do: missing tests, missing edge cases, missing
  error handling at trust boundaries.
- Keep scope discipline. Flag changes that mix unrelated concerns.

Your final verdict must be exactly one of: APPROVE, REQUEST_CHANGES, NEEDS_DISCUSSION.`;

function formatFileMap(fileMap) {
  if (!fileMap || Object.keys(fileMap).length === 0) return '(no full-file context provided)';
  return Object.entries(fileMap)
    .map(([p, content]) => `=== ${p} ===\n${content}`)
    .join('\n\n');
}

function buildReviewPrompt({ prTitle, prBody, diff, fileMap }) {
  return `# Pull Request
Title: ${prTitle}

Body:
${prBody || '(no body provided)'}

# Diff
${diff}

# Full File Context
${formatFileMap(fileMap)}

# Your Review

Produce a structured review with exactly these sections, in order. Use markdown
headings.

## 1. Bug Risk
Identify potential bugs introduced by this change. Cite file:line for each.

## 2. Edge Cases
Enumerate edge cases the author may have missed. Be specific — input shapes,
concurrent calls, empty/null/large inputs, error paths.

## 3. Test Coverage
Evaluate whether the new or changed behavior is adequately tested. Flag any gap.

## 4. Scope Creep
Flag any changes that fall outside the stated PR scope, or that bundle unrelated
concerns into the same PR.

## 5. Verdict
State one of: **APPROVE**, **REQUEST_CHANGES**, **NEEDS_DISCUSSION**.

Follow it with a one-paragraph justification that ties the verdict to the most
load-bearing finding above.`;
}

module.exports = { REVIEW_SYSTEM_PROMPT, buildReviewPrompt };
