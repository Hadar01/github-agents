const fs = require('fs');
const os = require('os');
const path = require('path');

// Mock the Anthropic SDK before requiring anything that uses it.
const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate }
  }));
});

const { runAgentLoop } = require('../src/agents/agentLoop');

function turn(content, usage = { input_tokens: 100, output_tokens: 20 }) {
  return {
    content,
    stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
    usage
  };
}

function thought(text) { return { type: 'text', text }; }
function toolUse(id, name, input) { return { type: 'tool_use', id, name, input }; }

describe('agent loop integration (mocked Anthropic SDK)', () => {
  let tmpDir;
  let ctx;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-int-'));
    fs.writeFileSync(path.join(tmpDir, 'src.js'), 'function add(a, b) { return a - b; }\n');
    ctx = { repoPath: tmpDir };
    mockCreate.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('agent reads file, applies patch, calls finish — diff is on disk', async () => {
    mockCreate
      .mockResolvedValueOnce(turn([
        thought('Let me look at the source.'),
        toolUse('t1', 'read_file', { path: 'src.js' })
      ]))
      .mockResolvedValueOnce(turn([
        thought('I see the bug — minus instead of plus.'),
        toolUse('t2', 'apply_patch', {
          path: 'src.js',
          old_string: 'a - b',
          new_string: 'a + b'
        })
      ]))
      .mockResolvedValueOnce(turn([
        toolUse('t3', 'finish', { pr_summary: 'Fixed add() to use addition.' })
      ]));

    const result = await runAgentLoop({
      systemPrompt: 'sys', userPrompt: 'fix the bug',
      ctx, maxIterations: 10
    });

    expect(result.finalSummary).toBe('Fixed add() to use addition.');
    expect(fs.readFileSync(path.join(tmpDir, 'src.js'), 'utf8')).toContain('a + b');
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  test('agent recovers when apply_patch fails (old_string not found)', async () => {
    mockCreate
      .mockResolvedValueOnce(turn([
        toolUse('t1', 'apply_patch', {
          path: 'src.js',
          old_string: 'this string is not in the file',
          new_string: 'whatever'
        })
      ]))
      .mockResolvedValueOnce(turn([
        thought('That failed. Let me re-read.'),
        toolUse('t2', 'read_file', { path: 'src.js' })
      ]))
      .mockResolvedValueOnce(turn([
        toolUse('t3', 'apply_patch', {
          path: 'src.js',
          old_string: 'a - b',
          new_string: 'a + b'
        })
      ]))
      .mockResolvedValueOnce(turn([
        toolUse('t4', 'finish', { pr_summary: 'Fixed.' })
      ]));

    const result = await runAgentLoop({
      systemPrompt: 'sys', userPrompt: 'fix',
      ctx, maxIterations: 10
    });

    expect(result.finalSummary).toBe('Fixed.');
    const failedToolEntry = result.history.find(
      h => h.kind === 'tool' && h.name === 'apply_patch' && !h.result.ok
    );
    expect(failedToolEntry).toBeDefined();
    expect(failedToolEntry.result.error).toMatch(/not found/);
  });

  test('agent halts at iteration limit when it never calls finish', async () => {
    mockCreate.mockResolvedValue(turn([
      toolUse('t', 'read_file', { path: 'src.js' })
    ]));

    const result = await runAgentLoop({
      systemPrompt: 'sys', userPrompt: 'loop forever',
      ctx, maxIterations: 3
    });

    expect(result.finalSummary).toBeNull();
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  test('agent aborts when cost limit is exceeded', async () => {
    // Each turn racks up huge usage so we cross $0.10 quickly.
    mockCreate.mockResolvedValue(turn(
      [toolUse('t', 'read_file', { path: 'src.js' })],
      { input_tokens: 5_000_000, output_tokens: 100_000 } // ~$82.50 in one turn
    ));

    const result = await runAgentLoop({
      systemPrompt: 'sys', userPrompt: 'expensive',
      ctx, maxIterations: 10, costLimitUsd: 0.10
    });

    expect(result.aborted).toBe('cost_limit');
    expect(result.stopReason).toBe('cost_limit');
    // Should only have run 1 turn — limit hit immediately after first response.
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('emits expected events in order', async () => {
    mockCreate
      .mockResolvedValueOnce(turn([
        thought('plan'),
        toolUse('t1', 'read_file', { path: 'src.js' })
      ]))
      .mockResolvedValueOnce(turn([
        toolUse('t2', 'finish', { pr_summary: 'done' })
      ]));

    const events = [];
    await runAgentLoop({
      systemPrompt: 'sys', userPrompt: 'go',
      ctx, maxIterations: 5,
      onEvent: e => events.push(e.type)
    });

    expect(events).toEqual([
      'turn_start',
      'thought',
      'tool_call',
      'tool_result',
      'turn_start',
      'tool_call',
      'tool_result',
      'finished'
    ]);
  });
});
