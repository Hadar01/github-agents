function parseGithubUrl(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

module.exports = { parseGithubUrl };
