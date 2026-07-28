# Task for worker

[Read from: D:\Documents\Repositories\agile-test\context.md, D:\Documents\Repositories\agile-test\plan.md]

Task: Add lint CI script to package.json

Project: D:/Documents/Repositories/agile-test

Add a new npm script 'lint:ci' to package.json that runs 'eslint . --max-warnings 0'. Do NOT change any other scripts or source files.

Instructions:
1. git checkout -b feat/agile-test-7b9
2. Edit package.json to add the script
3. Verify: npx eslint . --max-warnings 0
4. git add -A && git commit -m 'feat: add lint:ci script'
5. Do NOT merge to main

---
Update progress at: D:\Documents\Repositories\pi-autoresearch\.pi-subagents\artifacts\progress\60860bb5\progress.md

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```