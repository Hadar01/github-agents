const fs = require('fs');
const os = require('os');
const path = require('path');

const { rankFiles, tokenize, scorePath } = require('../src/mapper/fileRelevance');

describe('fileRelevance — keyword scorer', () => {
  let tmp;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-'));
    fs.mkdirSync(path.join(tmp, 'src', 'auth'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'src', 'auth', 'login.py'),
      'def login(email, password):\n    return email.lower() == "admin"\n'
    );
    fs.writeFileSync(
      path.join(tmp, 'src', 'app.py'),
      'from .auth.login import login\n'
    );
    fs.writeFileSync(
      path.join(tmp, 'src', 'unrelated.py'),
      'def compute_fft():\n    pass\n'
    );
    fs.writeFileSync(
      path.join(tmp, 'src', 'quantum_circuit.py'),
      'class Circuit:\n    pass\n'
    );
  });

  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('tokenize drops stopwords and short words', () => {
    const toks = tokenize('Fix the login when email is uppercase');
    expect(toks.has('login')).toBe(true);
    expect(toks.has('email')).toBe(true);
    expect(toks.has('uppercase')).toBe(true);
    expect(toks.has('the')).toBe(false);
    expect(toks.has('fix')).toBe(false);  // stopword
    expect(toks.has('is')).toBe(false);
  });

  test('scorePath rewards basename matches more than dir matches', () => {
    const toks = new Set(['login']);
    const basenameHit = scorePath('src/auth/login.py', toks);
    const dirHit = scorePath('login/other.py', toks);
    const miss = scorePath('src/app.py', toks);
    expect(basenameHit).toBeGreaterThan(dirHit);
    expect(dirHit).toBeGreaterThan(miss);
  });

  test('rankFiles puts the most-relevant file first', () => {
    const files = ['src/auth/login.py', 'src/app.py', 'src/unrelated.py', 'src/quantum_circuit.py'];
    const ranked = rankFiles({
      repoPath: tmp, files,
      issueText: 'Login fails when email contains uppercase',
      topK: 4
    });
    expect(ranked[0].path).toBe('src/auth/login.py');
  });

  test('rankFiles returns empty when no tokens match any file', () => {
    const files = ['a.py', 'b.py', 'c.py'];
    const ranked = rankFiles({
      repoPath: tmp, files,
      issueText: 'xyzzy quuxbaz',
      topK: 3
    });
    // Better to return nothing than a false-positive shortlist.
    expect(ranked).toEqual([]);
  });

  test('rankFiles returns a stable head slice when issue text is empty', () => {
    const files = ['a.py', 'b.py', 'c.py'];
    const ranked = rankFiles({
      repoPath: tmp, files, issueText: '', topK: 3
    });
    expect(ranked.length).toBe(3);
    expect(ranked[0].score).toBe(0);
  });

  test('rankFiles tolerates unreadable files gracefully', () => {
    const ranked = rankFiles({
      repoPath: tmp,
      files: ['src/does-not-exist.py', 'src/auth/login.py'],
      issueText: 'login bug',
      topK: 2
    });
    // Should still return a result and not throw.
    expect(Array.isArray(ranked)).toBe(true);
  });

  test('ties break by shorter path', () => {
    const shallow = path.join(tmp, 'login.py');
    const deep = path.join(tmp, 'src', 'app', 'modules', 'login.py');
    fs.mkdirSync(path.dirname(deep), { recursive: true });
    fs.writeFileSync(shallow, 'def login(): pass\n');
    fs.writeFileSync(deep, 'def login(): pass\n');
    const ranked = rankFiles({
      repoPath: tmp,
      files: ['src/app/modules/login.py', 'login.py'],
      issueText: 'login issue',
      topK: 2
    });
    expect(ranked[0].path).toBe('login.py');
  });
});
