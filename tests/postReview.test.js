// The PR-review posting ladder. A 422 from createReview has two opposite
// causes — a rejected event (can't self-approve) vs. a bad inline anchor — and
// the ladder must apply the right remedy so inline comments survive whenever
// possible, only collapsing to summary-only as a last resort.

process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.GITHUB_TOKEN = 'ghp_test';

const { postReviewWithFallback } = require('../src/pipeline');

const err422 = () => Object.assign(new Error('Unprocessable Entity'), { status: 422 });

// Build a fake createReview that records calls and throws 422 whenever `reject`
// returns true for the given args. Returns a stand-in response on success.
function makeCreateReview(reject) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    if (reject(args)) throw err422();
    return { data: { html_url: `https://gh/review/${calls.length}` } };
  };
  return { fn, calls };
}

const base = {
  event: 'APPROVE',
  body: 'BODY_WITH_DROPPED',
  bodyAllInline: 'BODY_WITH_ALL',
  anchored: [{ path: 'a.js', line: 12, side: 'RIGHT', body: 'x' }]
};

describe('postReviewWithFallback', () => {
  test('ideal path: posts declared event WITH inline comments, once', async () => {
    const { fn, calls } = makeCreateReview(() => false);
    const res = await postReviewWithFallback({ ...base, createReview: fn });
    expect(res.data.html_url).toMatch(/review\/1/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ event: 'APPROVE', body: 'BODY_WITH_DROPPED' });
    expect(calls[0].comments).toHaveLength(1);
  });

  test("self-approve (event rejected): downgrades to COMMENT but KEEPS inline comments", async () => {
    // Reject only APPROVE/REQUEST_CHANGES; COMMENT (with or without comments) is fine.
    const { fn, calls } = makeCreateReview((a) => a.event !== 'COMMENT');
    const res = await postReviewWithFallback({ ...base, createReview: fn });
    expect(res.data.html_url).toBeTruthy();
    expect(calls).toHaveLength(2);
    expect(calls[0].event).toBe('APPROVE');
    expect(calls[1].event).toBe('COMMENT');
    // The whole point: inline comments are preserved through the downgrade.
    expect(calls[1].comments).toHaveLength(1);
    expect(calls[1].body).toBe('BODY_WITH_DROPPED');
  });

  test('bad anchor: drops inline comments, posts summary-only COMMENT with all findings', async () => {
    // Any call carrying `comments` 422s; a comment-less COMMENT succeeds.
    const { fn, calls } = makeCreateReview((a) => !!a.comments);
    const res = await postReviewWithFallback({ ...base, createReview: fn });
    expect(res.data.html_url).toBeTruthy();
    expect(calls).toHaveLength(3);                      // APPROVE+c, COMMENT+c, COMMENT
    const final = calls[calls.length - 1];
    expect(final.event).toBe('COMMENT');
    expect(final.comments).toBeUndefined();
    expect(final.body).toBe('BODY_WITH_ALL');           // everything folded into prose
  });

  test('event already COMMENT + bad anchor: one retry, summary-only', async () => {
    const { fn, calls } = makeCreateReview((a) => !!a.comments);
    const res = await postReviewWithFallback({ ...base, event: 'COMMENT', createReview: fn });
    expect(res.data.html_url).toBeTruthy();
    expect(calls).toHaveLength(2);                      // COMMENT+c (422), COMMENT
    expect(calls[1].comments).toBeUndefined();
    expect(calls[1].body).toBe('BODY_WITH_ALL');
  });

  test('no inline comments to begin with: single clean call', async () => {
    const { fn, calls } = makeCreateReview(() => false);
    const res = await postReviewWithFallback({ ...base, anchored: [], createReview: fn });
    expect(res.data.html_url).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0].comments).toBeUndefined();
  });

  test('non-422 errors propagate (no silent swallow)', async () => {
    const fn = async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); };
    await expect(postReviewWithFallback({ ...base, createReview: fn })).rejects.toThrow(/forbidden/);
  });

  test('throws if even summary-only fails, so caller can fall back to an issue comment', async () => {
    const fn = async () => { throw err422(); };          // everything 422s
    await expect(postReviewWithFallback({ ...base, createReview: fn })).rejects.toHaveProperty('status', 422);
  });
});
