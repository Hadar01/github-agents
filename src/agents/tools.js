const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const simpleGit = require('simple-git');

const { TEST_COMMAND_TIMEOUT_MS, TOOL_OUTPUT_TRUNCATE } = require('../config');
const { buildRepoMap } = require('../mapper/repoMap');

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
    description: 'List source files (.js, .ts, .py) under a directory. Skips node_modules, .git, dist, build. Use "" for repo root.',
    input_schema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Directory relative to the repo root' }
      },
      required: ['dir']
    }
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with the given contents. Prefer apply_patch for edits to existing files.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'apply_patch',
    description: 'Replace an exact string in a file with new text. Fails if old_string is not found OR appears more than once. Provide enough surrounding context to make old_string unique.',
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
    name: 'run_tests',
    description: 'Run the test suite. Returns stdout, stderr, exit code. Allowed commands start with: npm test, npm run test, yarn test, pnpm test, pytest, python -m pytest, go test, cargo test.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' }
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
  }
];

const ALLOWED_TEST_COMMAND_PREFIXES = [
  'npm test', 'npm run test', 'yarn test', 'pnpm test',
  'pytest', 'python -m pytest',
  'go test', 'cargo test'
];

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
    const files = buildRepoMap(base);
    return { ok: true, count: files.length, files: files.slice(0, 500) };
  },

  async write_file({ path: rel, content }, ctx) {
    const full = safeJoin(ctx.repoPath, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return { ok: true, message: `Wrote ${rel} (${content.length} bytes)` };
  },

  async apply_patch({ path: rel, old_string, new_string }, ctx) {
    const full = safeJoin(ctx.repoPath, rel);
    const current = fs.readFileSync(full, 'utf8');
    const occurrences = current.split(old_string).length - 1;
    if (occurrences === 0) {
      return { ok: false, error: `old_string not found in ${rel}. Re-read the file and check whitespace/newlines.` };
    }
    if (occurrences > 1) {
      return { ok: false, error: `old_string appears ${occurrences} times in ${rel}. Add more surrounding context to make it unique.` };
    }
    fs.writeFileSync(full, current.replace(old_string, new_string));
    return { ok: true, message: `Patched ${rel}` };
  },

  async run_tests({ command }, ctx) {
    const allowed = ALLOWED_TEST_COMMAND_PREFIXES.some(p => command.trim().startsWith(p));
    if (!allowed) {
      return {
        ok: false,
        error: `Command not in allowlist. Allowed prefixes: ${ALLOWED_TEST_COMMAND_PREFIXES.join(', ')}`
      };
    }
    const result = spawnSync(command, {
      shell: true,
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
    return { ok: true, finished: true, pr_summary };
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
  ALLOWED_TEST_COMMAND_PREFIXES
};
