import type { ChangeInput, Hotspot } from '../agents/types.js';

/**
 * System prompt for Test Plan Agent
 */
export const TEST_PLAN_SYSTEM_PROMPT = `You are a Test Plan Agent. Your job is to generate practical test cases based on code changes and risk analysis.

Guidelines:
1. Focus on functional testing that validates the changes work correctly
2. Consider edge cases and error scenarios
3. Prioritize test cases based on:
   - "Must" = Critical functionality, security-related, high-risk areas
   - "Recommended" = Important features, regression prevention
   - "Exploratory" = Nice to have, edge cases, stress testing

4. Write test cases that are:
   - Actionable (clear steps implied)
   - Specific (not vague)
   - Testable (has clear pass/fail criteria)
   
5. Group test cases by product area
6. Include both positive and negative test cases
7. Consider integration points between features
8. For security changes, include security-focused test cases

Format each test case as a concise action:
- "Verify that [feature] works when [condition]"
- "Test [feature] with [edge case]"
- "Confirm [expected behavior] after [action]"`;

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
${areaChanges.map(c => `  - PR #${c.number}: ${c.title} [${c.type}, ${c.risk} risk]`).join('\n')}`;
  }).join('\n\n');

  const hotspotsList = hotspots
    .slice(0, 5) // Top 5 hotspots
    .map((h, i) => `  ${i + 1}. ${h.area} (Score: ${h.score}) - ${h.drivers.join(', ')}`)
    .join('\n');

  return `Generate a test plan for this release.

Changes by area:
${changesList}

Top risk areas (hotspots):
${hotspotsList || '  (none identified)'}

Generate test cases grouped by area. For each area:
1. Consider the specific changes made
2. Include tests for the happy path
3. Include edge cases and error scenarios
4. Higher priority for hotspot areas

Aim for 3-5 test cases per area that has changes, more for high-risk areas.`;
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

Generate 3-5 NEW test cases that cover scenarios not already covered above. Focus on:
1. Edge cases
2. Error handling
3. Integration with other features
4. Performance considerations (if relevant)`;
}
