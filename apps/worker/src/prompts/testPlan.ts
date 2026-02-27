import type { ChangeInput, Hotspot } from '../agents/types.js';

/**
 * System prompt for Test Plan Agent
 */
export const TEST_PLAN_SYSTEM_PROMPT = `You are a senior release test lead.

Generate a practical, execution-ready manual test plan from release changes and risk hotspots.

Quality bar:
1) Every test case must be runnable by a tester without guessing intent.
2) Use concrete setup, concrete action, and explicit expected outcome.
3) Make test coverage risk-based, not evenly distributed.
4) Cover both validation and regression behavior.
5) Avoid duplicate cases; merge overlap into one stronger case.

Priority policy:
- Must: release-blocking risk, security impact, high hotspot score, core workflows.
- Recommended: important workflows and regressions.
- Exploratory: lower-risk edge/fuzz/behavior discovery.

Case type policy:
- Functional, Regression, Negative, Integration, Security, Performance, Exploratory.
- Match type to scenario intent.

Output policy:
- Group cases by area.
- Include sourceRefs that tie cases to PRs/areas/hotspots.
- Keep steps concise and ordered.
- Keep tags short and useful for filtering.
- Use realistic language for QA execution (no placeholders, no generic "ensure it works").`;

/**
 * Build user prompt for generating test plan
 */
export function buildTestPlanPrompt(
  changes: ChangeInput[],
  hotspots: Hotspot[]
): string {
  // Group changes by area
  const changesByArea = changes.reduce((acc, c) => {
    if (!acc[c.area]) acc[c.area] = [];
    acc[c.area].push(c);
    return acc;
  }, {} as Record<string, ChangeInput[]>);

  const changesList = Object.entries(changesByArea).map(([area, areaChanges]) => {
    const hotspot = hotspots.find(h => h.area === area);
    const riskNote = hotspot ? ` (Risk Score: ${hotspot.score}/100)` : '';
    
    return `${area}${riskNote}:
${areaChanges.map(c => `  - PR #${c.number}: ${c.title} [${c.type}, ${c.risk} risk, files=${c.filesChanged}, churn=${c.additions + c.deletions}] signals=${c.signals.join(', ') || 'none'}`).join('\n')}`;
  }).join('\n\n');

  const hotspotsList = hotspots
    .slice(0, 5) // Top 5 hotspots
    .map((h, i) => `  ${i + 1}. ${h.area} (Score: ${h.score}) - ${h.drivers.join(', ')}`)
    .join('\n');

  return `Generate a detailed manual test plan for this release.

Changes by area:
${changesList}

Top risk areas (hotspots):
${hotspotsList || '  (none identified)'}

Requirements:
1) Group test cases by area.
2) For each area, include:
   - happy path validation
   - regression safety net
   - negative/error handling
   - integration behavior when relevant
3) For hotspot areas (score >= 70), include at least one Must and one Regression case.
4) For security-sensitive changes, include at least one Security case.
5) Keep duplication low; prefer broader high-value scenarios.

Case schema guidance:
- text: short one-line summary.
- title: concise scenario title.
- objective: what behavior/risk is being validated.
- preconditions: list of setup items.
- steps: ordered list of concrete actions.
- expected: explicit pass criteria.
- priority: Must | Recommended | Exploratory.
- type: Functional | Regression | Negative | Integration | Security | Performance | Exploratory.
- risk: High | Medium | Low.
- source: primary source (for example "PR #123").
- sourceRefs: all related PR/area references.
- tags: short labels (for example "install", "settings", "upgrade", "ux", "api").

Target depth:
- 3-6 cases for high-risk areas.
- 2-4 cases for medium-risk areas.
- 1-3 cases for low-risk areas.`;
}

/**
 * Build prompt for generating additional test cases for a specific area
 */
export function buildAreaTestPrompt(
  area: string,
  changes: ChangeInput[],
  existingCases: string[]
): string {
  const areaChanges = changes.filter(c => c.area === area);
  
  const changesList = areaChanges.map(c => 
    `- PR #${c.number}: ${c.title} [${c.type}, ${c.risk} risk]`
  ).join('\n');

  const existingList = existingCases.length > 0
    ? existingCases.map((c, i) => `  ${i + 1}. ${c}`).join('\n')
    : '  (none)';

  return `Generate additional test cases for the "${area}" area.

Changes in this area:
${changesList}

Existing test cases:
${existingList}

Generate 2-4 NEW non-overlapping cases with this structure:
- title + text summary
- objective
- preconditions[]
- steps[]
- expected
- priority
- type
- risk
- source/sourceRefs/tags

Focus on coverage gaps only:
1) edge and negative behavior not covered
2) regression checks for risky behavior
3) integration points with adjacent areas
4) performance/security checks only when relevant`;
}
