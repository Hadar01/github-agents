const { parseGithubUrl } = require('../src/utils/githubUrl');

describe('parseGithubUrl', () => {
  test('parses an issue URL', () => {
    expect(parseGithubUrl('https://github.com/anthropics/claude-code/issues/42'))
      .toEqual({ owner: 'anthropics', repo: 'claude-code', number: 42 });
  });

  test('parses a pull request URL', () => {
    expect(parseGithubUrl('https://github.com/octocat/Hello-World/pull/1234'))
      .toEqual({ owner: 'octocat', repo: 'Hello-World', number: 1234 });
  });

  test('parses URL with trailing path segments', () => {
    expect(parseGithubUrl('https://github.com/owner/repo/pull/7/files'))
      .toEqual({ owner: 'owner', repo: 'repo', number: 7 });
  });

  test('returns null for non-GitHub URLs', () => {
    expect(parseGithubUrl('https://gitlab.com/owner/repo/issues/1')).toBeNull();
  });

  test('returns null for malformed input', () => {
    expect(parseGithubUrl('not a url')).toBeNull();
    expect(parseGithubUrl('')).toBeNull();
    expect(parseGithubUrl(null)).toBeNull();
    expect(parseGithubUrl(undefined)).toBeNull();
  });

  test('returns null when missing the issue/pull number', () => {
    expect(parseGithubUrl('https://github.com/owner/repo')).toBeNull();
    expect(parseGithubUrl('https://github.com/owner/repo/issues/')).toBeNull();
  });
});
