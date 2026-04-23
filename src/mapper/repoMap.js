const fs = require('fs');
const path = require('path');

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__', '.venv', 'venv']);
const ALLOWED_EXTENSIONS = new Set(['.js', '.ts', '.py']);

function buildRepoMap(rootPath) {
  const files = [];

  function walk(dir, rel) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, next);
      } else if (entry.isFile() && ALLOWED_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(next);
      }
    }
  }

  walk(rootPath, '');
  return files;
}

function buildContextMap(rootPath, files) {
  const map = {};
  for (const file of files) {
    map[file] = fs.readFileSync(path.join(rootPath, file), 'utf8');
  }
  return map;
}

module.exports = { buildRepoMap, buildContextMap };
