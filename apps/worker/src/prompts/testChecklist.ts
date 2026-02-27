import type { ChangeInput, TestCase } from '../agents/types.js';

export const DEFAULT_TEST_CHECKLIST_TEMPLATE_URL =
  'https://raw.githubusercontent.com/microsoft/PowerToys/releaseChecklist/doc/releases/tests-checklist-template-advanced-paste-section.md';

export const FALLBACK_TEST_CHECKLIST_TEMPLATE = `[Go back](tests-checklist-template.md)

## Module Name
  NOTES:
    Add context-sensitive execution notes for this module.
 * Core scenario
   - [ ] Validate happy path behavior.
   - [ ] Validate negative behavior and error handling.
 * Regression scenario
   - [ ] Validate existing behavior did not regress after the change.
`;

function formatAreaCases(areaCases: TestCase[]): string {
  if (!areaCases.length) return 'No pre-generated cases are available for this area.';
  return areaCases
    .slice(0, 12)
    .map((c, idx) => {
      const pre = (c.preconditions ?? []).slice(0, 3).join(' | ');
      const steps = (c.steps ?? []).slice(0, 4).join(' | ');
      return [
        `${idx + 1}. ${c.title} [${c.priority}/${c.type}/${c.risk}]`,
        `   Objective: ${c.objective}`,
        `   Preconditions: ${pre || 'n/a'}`,
        `   Steps: ${steps || 'n/a'}`,
        `   Expected: ${c.expected}`,
      ].join('\n');
    })
    .join('\n');
}

export function buildChecklistPrompt(input: {
  change: ChangeInput;
  changedFiles?: Array<{ path: string; additions: number; deletions: number }>;
  templateMarkdown: string;
  areaCases: TestCase[];
}): string {
  const { change, changedFiles, templateMarkdown, areaCases } = input;
  const fileSummary = Array.isArray(changedFiles)
    ? changedFiles
        .slice(0, 25)
        .map((f) => `- ${f.path} (+${f.additions ?? 0}/-${f.deletions ?? 0})`)
        .join('\n')
    : '- File list unavailable';

  return `Generate a markdown release checklist for a single PR based on the provided template style.

PR metadata:
- PR: #${change.number}
- Title: ${change.title}
- Area: ${change.area}
- Type: ${change.type}
- Risk: ${change.risk}
- Author: ${change.author}
- Files changed: ${change.filesChanged}
- Churn: +${change.additions} / -${change.deletions}
- Signals: ${(change.signals ?? []).join(', ') || 'none'}

Changed files:
${fileSummary}

Existing area test cases (for reuse/reference):
${formatAreaCases(areaCases)}

Template markdown to follow:
${templateMarkdown}

Hard requirements:
1. Output valid markdown only.
2. Keep checkbox list format with '- [ ]'.
3. Keep a structure close to the template, but adapt to this PR.
4. Include explicit verification for: happy path, regression, negative/error behavior.
5. Include at least one checklist item that validates this PR's highest-risk changed behavior.
6. Mention PR number in the title/header.
7. Keep it concise and executable by manual QA.
8. Do not include placeholders like TODO or TBD.
`;
}

export function buildHeuristicChecklist(input: {
  change: ChangeInput;
  areaCases: TestCase[];
}): string {
  const { change, areaCases } = input;
  const topCases = areaCases.slice(0, 6);
  const topCaseLines = topCases.length
    ? topCases.map((c) => `   - [ ] ${c.title}: ${c.expected}`).join('\n')
    : `   - [ ] Validate PR #${change.number} primary scenario for ${change.area}.`;

  return `## ${change.area} - PR #${change.number}
  NOTES:
    Generated fallback checklist from release agent.
 * PR scope validation
   - [ ] Review PR #${change.number} (${change.title}) implementation intent.
   - [ ] Validate changed behavior in ${change.area} works as expected.
 * Risk-focused checks
   - [ ] Validate high-risk path based on ${change.risk} risk assessment.
   - [ ] Validate error handling path for this change.
 * Regression checks
${topCaseLines}
 * Integration checks
   - [ ] Validate integration touchpoints still function after PR #${change.number}.
`;
}
