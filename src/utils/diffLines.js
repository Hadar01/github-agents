// GitHub only accepts an inline PR review comment when its (file, line) lands on
// a line that appears in the PR's diff hunks — anything else makes
// `pulls.createReview` reject the ENTIRE review with a 422. So before we post
// model-generated findings as inline comments, we validate each one against the
// set of commentable lines parsed straight out of the unified diff.
//
// We anchor on the RIGHT (new-file) side only: added (`+`) and context (` `)
// lines, numbered by the hunk's new-side counter. Deleted (`-`) lines are
// left-side and not valid RIGHT anchors, so they're excluded.

// Parse a unified diff into Map<filePath, Set<newLineNumber>>.
function parseDiffLines(diff) {
  const byFile = new Map();
  if (!diff || typeof diff !== 'string') return byFile;

  let currentFile = null;
  let newLine = 0;

  for (const raw of diff.split('\n')) {
    // New file target. `+++ b/path` (or `+++ path`). `/dev/null` = deletion.
    if (raw.startsWith('+++ ')) {
      const target = raw.slice(4).trim();
      if (target === '/dev/null') {
        currentFile = null;
      } else {
        currentFile = target.replace(/^b\//, '').replace(/\t.*$/, '');
        if (!byFile.has(currentFile)) byFile.set(currentFile, new Set());
      }
      continue;
    }
    // Ignore the old-file header and the `diff --git` line entirely.
    if (raw.startsWith('--- ') || raw.startsWith('diff --git')) continue;

    // Hunk header: @@ -oldStart,oldLen +newStart,newLen @@
    if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      newLine = m ? parseInt(m[1], 10) : 0;
      continue;
    }

    if (currentFile === null || newLine === 0) continue;

    if (raw.startsWith('+')) {
      // Added line — commentable, advances the new-side counter.
      byFile.get(currentFile).add(newLine);
      newLine += 1;
    } else if (raw.startsWith('-')) {
      // Deleted line — left side only, does not advance the new counter.
      continue;
    } else if (raw.startsWith(' ')) {
      // Context line (always carries a leading space) — commentable.
      byFile.get(currentFile).add(newLine);
      newLine += 1;
    }
    // Anything else (an empty separator line, "\ No newline at end of file",
    // or stray text) is not hunk content — skip without advancing.
  }
  return byFile;
}

// Is (file, line) a valid RIGHT-side inline-comment anchor for this diff?
function isCommentable(diffLineMap, file, line) {
  const set = diffLineMap.get(file);
  return !!set && set.has(line);
}

module.exports = { parseDiffLines, isCommentable };
