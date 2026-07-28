# Task for worker

[Read from: D:\Documents\Repositories\agile-test\context.md, D:\Documents\Repositories\agile-test\plan.md]

Task: Refactor auth.js - extract password utilities

Project: D:/Documents/Repositories/agile-test

Move hashPassword and verifyPassword from src/auth.js to a new src/lib/password.js file. Import and re-export from auth.js. Keep auth.js clean. No behavior change.

Instructions:
1. git checkout -b feat/agile-test-739
2. Implement the change
3. Run tests: node --test 'tests/**/*.test.js'
4. git add -A && git commit -m 'feat: extract password utilities'
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