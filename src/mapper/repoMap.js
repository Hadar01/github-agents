const fs = require('fs');
const path = require('path');

// Directories to skip when walking. Covers Node, Python, Rust, Go, Java,
// common CI/IDE artefacts, and doc-build output — so the walker does not
// explode on large real-world projects (TQEC-scale Python, Kubernetes,
// Rust monorepos with vendored deps).
const IGNORE_DIRS = new Set([
  // Node
  'node_modules', 'dist', 'build', '.next', 'coverage', '.turbo',
  // VCS
  '.git', '.hg', '.svn',
  // Python
  '__pycache__', '.venv', 'venv', 'env',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.pytype',
  '.tox', '.nox', '.eggs', 'htmlcov',
  // Rust / Go / Java / Gradle
  'target', 'vendor', '.gradle', '.m2',
  // Editor / OS
  '.idea', '.vscode', '.DS_Store',
  // Docs build
  '_build', 'site',
]);
// Source files: the agent is expected to edit these.
const SOURCE_EXTENSIONS = new Set([
  // JS/TS
  '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs',
  // Python (incl. Cython/typeshed)
  '.py', '.pyx', '.pxd', '.pyi',
  // Native / scientific Python dependencies
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh',
  // Other mainstream
  '.rs', '.go', '.java', '.kt', '.rb', '.php', '.swift', '.scala',
]);

// Project/config files: the agent can READ these to orient itself (detect
// test command, read CONTRIBUTING.md, read PR template, understand package
// layout), but shouldn't treat them as normal source targets.
const CONFIG_EXTENSIONS = new Set([
  '.toml', '.cfg', '.ini', '.yaml', '.yml', '.json',
  '.md', '.rst', '.txt',
]);

const SPECIAL_FILENAMES = new Set([
  'Makefile', 'makefile', 'GNUmakefile',
  'Dockerfile', 'dockerfile',
  'tox.ini', 'noxfile.py', 'pyproject.toml', 'setup.py', 'setup.cfg',
  'package.json', 'Cargo.toml', 'go.mod',
  'CONTRIBUTING.md', 'CONTRIBUTING.rst',
  'CODE_OF_CONDUCT.md',
]);

const ALLOWED_EXTENSIONS = new Set([...SOURCE_EXTENSIONS, ...CONFIG_EXTENSIONS]);

// Hard cap so a single list_files call can't consume the agent's context.
const DEFAULT_FILE_CAP = 2000;

function buildRepoMap(rootPath, { prefix = '', maxFiles = DEFAULT_FILE_CAP } = {}) {
  const files = [];
  let total = 0;
  let truncated = false;

  function walk(dir, rel) {
    if (truncated) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, don't crash the walk
    }
    for (const entry of entries) {
      if (truncated) return;
      if (IGNORE_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.') && IGNORE_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, next);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        const isRelevant = ALLOWED_EXTENSIONS.has(ext) || SPECIAL_FILENAMES.has(entry.name);
        if (!isRelevant) continue;
        total++;
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
        files.push(prefix ? `${prefix}/${next}` : next);
      }
    }
  }

  walk(rootPath, '');
  return { files, total, truncated, cap: maxFiles };
}

module.exports = {
  buildRepoMap,
  IGNORE_DIRS,
  ALLOWED_EXTENSIONS,
  SOURCE_EXTENSIONS,
  CONFIG_EXTENSIONS,
  SPECIAL_FILENAMES,
  DEFAULT_FILE_CAP
};
