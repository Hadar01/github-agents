const { runAgentLoop } = require('./agentLoop');
const {
  SYSTEM_PROMPT,
  buildIssuePrompt,
  buildRevisionPrompt
} = require('../prompts/engineering');

async function runEngineeringAgent({ issue, repoPath, testCommand, costLimitUsd, onEvent }) {
  return runAgentLoop({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildIssuePrompt({
      issueTitle: issue.title,
      issueBody: issue.body || '',
      testCommand
    }),
    ctx: { repoPath },
    costLimitUsd,
    onEvent
  });
}

async function runRevisionPass({ issue, repoPath, testCommand, reviewText, currentDiff, costLimitUsd, onEvent }) {
  return runAgentLoop({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildRevisionPrompt({
      issueTitle: issue.title,
      reviewText,
      currentDiff,
      testCommand
    }),
    ctx: { repoPath },
    costLimitUsd,
    onEvent
  });
}

module.exports = { runEngineeringAgent, runRevisionPass };
