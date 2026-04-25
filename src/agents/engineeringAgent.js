const { runAgentLoop } = require('./agentLoop');
const {
  SYSTEM_PROMPT,
  buildIssuePrompt,
  buildRevisionPrompt
} = require('../prompts/engineering');

async function runEngineeringAgent({
  issue, repoPath, testCommand, costLimitUsd, onEvent,
  // New optional context passed through to the prompt so the agent starts
  // oriented instead of blindly exploring on turn 1.
  lintCommands,
  subPackage,
  contributing,
  relevantFileHints
}) {
  return runAgentLoop({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildIssuePrompt({
      issueTitle: issue.title,
      issueBody: issue.body || '',
      testCommand,
      lintCommands,
      subPackage,
      contributing,
      relevantFileHints
    }),
    ctx: { repoPath },
    costLimitUsd,
    onEvent
  });
}

async function runRevisionPass({
  issue, repoPath, testCommand, reviewText, currentDiff, costLimitUsd, onEvent
}) {
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
