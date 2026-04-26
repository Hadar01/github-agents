const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const simpleGit = require('simple-git');

const { TEST_COMMAND_TIMEOUT_MS, TOOL_OUTPUT_TRUNCATE } = require('../config');
const { buildRepoMap } = require('../mapper/repoMap');
const { rankFiles } = require('../mapper/fileRelevance');

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read the full contents of a file from the working repository. Returns the file text.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the repo root' }
      },
      required: ['path']
    }
  },
  {
    name: 'list_files',
    description: 'List source + config files under a directory. Skips node_modules, .git, target, vendor, .mypy_cache, .pytest_cache, .tox, and other build/cache dirs. Use "" for repo root. If the result is truncated, pass a more specific dir.',
    input_schema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Directory relative to the repo root' }
      },
      required: ['dir']
    }
  },
  {
    name: 'find_relevant_files',
    description: 'Score files against a natural-language query (e.g. the issue title + keywords) and return the top-N most likely relevant paths. Use this on large repos before list_files to avoid context-window blowout.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Issue text or search keywords' },
        top_k: { type: 'number', description: 'Max results to return (default 30)' }
      },
      required: ['query']
    }
  },
  {
    name: 'write_file',
    description: 'Create a new file with the given contents. REFUSES to overwrite an existing file unless overwrite:true is passed (use apply_patch or apply_patch_range for edits).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        overwrite: { type: 'boolean', description: 'Explicit opt-in to replace an existing file wholesale. Default false.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'apply_patch',
    description: 'Replace an exact string in a file. Fails if old_string is not found OR appears more than once. If exact match fails, the tool automatically retries with whitespace-normalized matching; if that uniquely matches, the patch applies. Error messages include the 3 closest lines so you can retry with better context.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' }
      },
      required: ['path', 'old_string', 'new_string']
    }
  },
  {
    name: 'apply_patch_range',
    description: 'Replace lines start_line..end_line (inclusive, 1-indexed) in a file with new_content. Use this when apply_patch keeps failing because of whitespace/indentation weirdness in the target (common in deeply-nested Python). Always read_file first to verify line numbers.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start_line: { type: 'number' },
        end_line: { type: 'number' },
        new_content: { type: 'string', description: 'Replacement text (do NOT add a trailing newline unless you want one).' }
      },
      required: ['path', 'start_line', 'end_line', 'new_content']
    }
  },
  {
    name: 'run_tests',
    description: 'Run the project test suite. Retries automatically up to 3 times on failure and flags flaky results. Allowed commands: npm test, npm run test, yarn test, pnpm test, pytest, python -m pytest, go test, cargo test, tox, nox, make.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' }
      },
      required: ['command']
    }
  },
  {
    name: 'run_lint',
    description: 'Run a project linter / formatter / type checker. Allowed: ruff, black, mypy, flake8, pylint, eslint, prettier, gofmt, rustfmt, cargo fmt, cargo clippy. Returns exit code + stdout/stderr.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'A lint command such as "ruff check ." or "eslint src/"' }
      },
      required: ['command']
    }
  },
  {
    name: 'git_diff',
    description: 'Show the git diff of all uncommitted changes in the working repository.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'git_status',
    description: 'Show which files are modified, created, or deleted in the working repository.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'finish',
    description: 'Signal that you have completed the engineering work AND verified it with passing tests. Provide a one-paragraph PR summary describing what changed and why.',
    input_schema: {
      type: 'object',
      properties: {
        pr_summary: { type: 'string' }
      },
      required: ['pr_summary']
    }
  },
  {
    name: 'give_up',
    description: 'Abort the run gracefully when the issue is out of scope for automated handling. Use this — NOT finish — if you would need to: change more than ~5 files, understand undocumented DSL semantics, touch compiled C/C++ extensions, reproduce behaviour that requires a GPU or specialised environment, or make architectural decisions no human has ratified. Shipping half-work is worse than shipping nothing. A human will take over.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Short label: too_complex, missing_env, out_of_scope, needs_human, test_env_missing, insufficient_info' },
        explanation: { type: 'string', description: 'One-paragraph explanation of what blocked you, for the human who picks this up.' },
        blockers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Concrete list of things that would unblock progress.'
        }
      },
      required: ['reason', 'explanation']
    }
  }
];

// Each entry is a token sequence. A caller's command must tokenize to start
// with one of these exact sequences — no shell splitting, no glob expansion,
// no `;`/`&&`/backticks. Extra positional arguments (flags, paths) are
// allowed after the prefix.
const ALLOWED_TEST_COMMANDS = [
  ['npm', 'test'],
  ['npm', 'run', 'test'],
  ['yarn', 'test'],
  ['pnpm', 'test'],
  ['pytest'],
  ['python', '-m', 'pytest'],
  ['go', 'test'],
  ['cargo', 'test'],
  // Scientific-Python / monorepo common runners
  ['tox'],
  ['nox'],
  ['make', 'test'],
  ['make', 'check']
];

const ALLOWED_LINT_COMMANDS = [
  ['ruff', 'check'],
  ['ruff', 'format', '--check'],
  ['black', '--check'],
  ['mypy'],
  ['flake8'],
  ['pylint'],
  ['eslint'],
  ['prettier', '--check'],
  ['gofmt', '-l'],
  ['go', 'vet'],
  ['cargo', 'fmt', '--check'],
  ['cargo', 'clippy']
];

const SHELL_METACHARS = /[;&|<>`$(){}\[\]\\!*?"']/;

function parseAllowlistedCommand(command, allowlist) {
  if (typeof command !== 'string') {
    return { error: 'command must be a string' };
  }
  const trimmed = command.trim();
  if (!trimmed) return { error: 'command is empty' };
  if (SHELL_METACHARS.test(trimmed)) {
    return { error: 'command contains disallowed shell metacharacters' };
  }
  const tokens = trimmed.split(/\s+/);
  const match = allowlist.find(prefix =>
    prefix.length <= tokens.length &&
    prefix.every((t, i) => t === tokens[i])
  );
  if (!match) {
    const pretty = allowlist.map(p => p.join(' ')).join(', ');
    return { error: `Command not in allowlist. Allowed prefixes: ${pretty}` };
  }
  // Windows needs the .cmd shim for node-based tools when shell: false.
  let exe = tokens[0];
  if (process.platform === 'win32' &&
      ['npm', 'yarn', 'pnpm', 'eslint', 'prettier'].includes(exe)) {
    exe = `${exe}.cmd`;
  }
  return { exe, args: tokens.slice(1) };
}

function parseTestCommand(command) {
  return parseAllowlistedCommand(command, ALLOWED_TEST_COMMANDS);
}

function parseLintCommand(command) {
  return parseAllowlistedCommand(command, ALLOWED_LINT_COMMANDS);
}

function safeJoin(repoPath, relPath) {
  if (typeof relPath !== 'string') {
    throw new Error('path must be a string');
  }
  const root = path.resolve(repoPath);
  const resolved = path.resolve(root, relPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing path outside repo root: ${relPath}`);
  }
  return resolved;
}

function truncate(s) {
  if (typeof s !== 'string') return s;
  if (s.length <= TOOL_OUTPUT_TRUNCATE) return s;
  return s.slice(0, TOOL_OUTPUT_TRUNCATE) + `\n...[truncated ${s.length - TOOL_OUTPUT_TRUNCATE} chars]`;
}

const HANDLERS = {
  async read_file({ path: rel }, ctx) {
    const full = safeJoin(ctx.repoPath, rel);
    const content = fs.readFileSync(full, 'utf8');
    return { ok: true, content: truncate(content) };
  },

  async list_files({ dir }, ctx) {
    const base = dir ? safeJoin(ctx.repoPath, dir) : ctx.repoPath;
    if (!fs.existsSync(base)) {
      return { ok: false, error: `Directory not found: ${dir}` };
    }
    // Paths are returned relative to the repo root (prefixed with `dir` when
    // walking a subdirectory), so the agent can feed them straight back to
    // read_file / apply_patch without losing its place.
    const result = buildRepoMap(base, { prefix: dir || '', maxFiles: 500 });
    return {
      ok: true,
      count: result.files.length,
      total: result.total,
      truncated: result.truncated,
      files: result.files,
      note: result.truncated
        ? `Result truncated at ${result.cap} of ${result.total} files. Pass a more specific dir (e.g. "src/submodule") to narrow the view.`
        : undefined
    };
  },

  async find_relevant_files({ query, top_k }, ctx) {
    const repoResult = buildRepoMap(ctx.repoPath, { maxFiles: 5000 });
    const ranked = rankFiles({
      repoPath: ctx.repoPath,
      files: repoResult.files,
      issueText: query,
      topK: top_k || 30
    });
    return {
      ok: true,
      scanned: repoResult.total,
      truncated_scan: repoResult.truncated,
      candidates: ranked.map(r => ({ path: r.path, score: r.score }))
    };
  },

  async write_file({ path: rel, content, overwrite }, ctx) {
    const full = safeJoin(ctx.repoPath, rel);
    const exists = fs.existsSync(full);
    if (exists && !overwrite) {
      return {
        ok: false,
        error: `File ${rel} already exists. Use apply_patch or apply_patch_range for edits, or pass overwrite:true if you genuinely want to replace the whole file.`
      };
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return {
      ok: true,
      message: `${exists ? 'Overwrote' : 'Created'} ${rel} (${content.length} bytes)`,
      overwrote: exists
    };
  },

  async apply_patch({ path: rel, old_string, new_string }, ctx) {
    const full = safeJoin(ctx.repoPath, rel);
    const current = fs.readFileSync(full, 'utf8');

    // Strategy 1 — exact match (current behaviour).
    const exact = current.split(old_string).length - 1;
    if (exact === 1) {
      fs.writeFileSync(full, current.replace(old_string, new_string));
      return { ok: true, message: `Patched ${rel} (exact match)` };
    }
    if (exact > 1) {
      return {
        ok: false,
        error: `old_string appears ${exact} times in ${rel}. Add more surrounding context to make it unique, or use apply_patch_range with line numbers.`
      };
    }

    // Strategy 2 — whitespace-normalized match. Build a pattern where runs
    // of whitespace in old_string match any whitespace in the file. This
    // handles the common failure mode of tabs-vs-spaces and trailing
    // whitespace drift in deeply-nested Python.
    const normalizedPattern = old_string
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s+');
    const re = new RegExp(normalizedPattern, 'g');
    const matches = current.match(re) || [];
    if (matches.length === 1) {
      const patched = current.replace(re, () => new_string);
      fs.writeFileSync(full, patched);
      return { ok: true, message: `Patched ${rel} (whitespace-normalized match)` };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        error: `old_string is ambiguous even with whitespace normalization (${matches.length} matches in ${rel}). Add more surrounding context or use apply_patch_range.`
      };
    }

    // Strategy 3 — return the three closest lines so the agent can retry.
    const snippet = old_string.split('\n')[0].trim();
    const lines = current.split('\n');
    const candidates = lines
      .map((line, idx) => ({ line: line.trim(), idx: idx + 1 }))
      .filter(l => l.line.length > 0 && snippet && l.line.includes(snippet.slice(0, 20)))
      .slice(0, 3);
    const hint = candidates.length
      ? ` Closest candidate lines: ${candidates.map(c => `L${c.idx}: ${c.line.slice(0, 80)}`).join(' | ')}`
      : '';
    return {
      ok: false,
      error: `old_string not found in ${rel}. Re-read the file and check whitespace/newlines.${hint}`
    };
  },

  async apply_patch_range({ path: rel, start_line, end_line, new_content }, ctx) {
    const full = safeJoin(ctx.repoPath, rel);
    const current = fs.readFileSync(full, 'utf8');
    const lines = current.split('\n');
    if (!Number.isInteger(start_line) || !Number.isInteger(end_line)) {
      return { ok: false, error: 'start_line and end_line must be integers (1-indexed, inclusive).' };
    }
    if (start_line < 1 || end_line < start_line || end_line > lines.length) {
      return { ok: false, error: `Invalid range ${start_line}..${end_line} for file with ${lines.length} lines.` };
    }
    // Replace slice. end_line is inclusive; splice deleteCount = end - start + 1.
    const newLines = new_content.split('\n');
    const before = lines.slice(0, start_line - 1);
    const after = lines.slice(end_line);
    const patched = [...before, ...newLines, ...after].join('\n');
    fs.writeFileSync(full, patched);
    return {
      ok: true,
      message: `Replaced lines ${start_line}..${end_line} in ${rel} (${end_line - start_line + 1} old → ${newLines.length} new)`
    };
  },

  async run_tests({ command }, ctx) {
    const parsed = parseTestCommand(command);
    if (parsed.error) {
      return { ok: false, error: parsed.error };
    }

    const MAX_ATTEMPTS = 3;
    let last = null;
    let attempts = 0;
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      attempts = i;
      last = spawnSync(parsed.exe, parsed.args, {
        shell: false,
        cwd: ctx.repoPath,
        encoding: 'utf8',
        timeout: TEST_COMMAND_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024
      });
      if (last.status === 0) break;
    }

    const passed = last.status === 0;
    const flaky = passed && attempts > 1;
    // Detect "test env not installed" failures so the agent can give_up
    // gracefully rather than looping forever on import errors.
    const stderr = (last.stderr || '') + (last.stdout || '');
    const envError = !passed && /ModuleNotFoundError|ImportError|No module named|command not found|cannot find module/i.test(stderr);
    return {
      ok: true,
      exit_code: last.status,
      passed,
      flaky,
      attempts,
      env_error: envError,
      stdout: truncate(last.stdout || ''),
      stderr: truncate(last.stderr || '')
    };
  },

  async run_lint({ command }, ctx) {
    const parsed = parseLintCommand(command);
    if (parsed.error) {
      return { ok: false, error: parsed.error };
    }
    const result = spawnSync(parsed.exe, parsed.args, {
      shell: false,
      cwd: ctx.repoPath,
      encoding: 'utf8',
      timeout: TEST_COMMAND_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024
    });
    return {
      ok: true,
      exit_code: result.status,
      passed: result.status === 0,
      stdout: truncate(result.stdout || ''),
      stderr: truncate(result.stderr || '')
    };
  },

  async git_diff(_input, ctx) {
    const diff = await simpleGit(ctx.repoPath).diff();
    return { ok: true, diff: truncate(diff || '(no changes)') };
  },

  async git_status(_input, ctx) {
    const s = await simpleGit(ctx.repoPath).status();
    return {
      ok: true,
      modified: s.modified,
      created: s.created,
      deleted: s.deleted,
      not_added: s.not_added,
      renamed: s.renamed
    };
  },

  async finish({ pr_summary }, _ctx) {
    return { ok: true, pr_summary };
  },

  async give_up({ reason, explanation, blockers }, _ctx) {
    return {
      ok: true,
      gave_up: true,
      reason: String(reason || 'unspecified'),
      explanation: String(explanation || ''),
      blockers: Array.isArray(blockers) ? blockers : []
    };
  }
};

async function dispatchTool(toolName, input, ctx) {
  const handler = HANDLERS[toolName];
  if (!handler) return { ok: false, error: `Unknown tool: ${toolName}` };
  try {
    return await handler(input, ctx);
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  TOOLS,
  HANDLERS,
  dispatchTool,
  safeJoin,
  ALLOWED_TEST_COMMANDS,
  ALLOWED_LINT_COMMANDS,
  parseTestCommand,
  parseLintCommand
};
