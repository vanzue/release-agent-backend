import pino from 'pino';
import { getLLMClient, type LLMClient } from '../llm.js';
import {
  TestPlanSchema,
  type TestPlan,
  type ChangeInput,
  type Hotspot,
  type TestCase,
  type RiskLevel,
  type TestCaseType,
  type TestPriority,
} from './types.js';
import {
  TEST_PLAN_SYSTEM_PROMPT,
  buildTestPlanPrompt,
  buildAreaTestPrompt,
} from '../prompts/testPlan.js';

const logger = pino({
  name: 'test-plan-agent',
  level: process.env.LOG_LEVEL ?? 'info',
});

const DEFAULT_PRECONDITION = 'Use a build that includes this release change.';
const DEFAULT_EXPECTED = 'Expected behavior is observed and no unexpected error is shown.';

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values));
}

function inferRisk(priority: TestPriority): RiskLevel {
  if (priority === 'Must') return 'High';
  if (priority === 'Recommended') return 'Medium';
  return 'Low';
}

function inferCaseType(priority: TestPriority): TestCaseType {
  if (priority === 'Must') return 'Regression';
  if (priority === 'Exploratory') return 'Exploratory';
  return 'Functional';
}

function toTag(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

function normalizeCase(
  testCase: Partial<TestCase> & Record<string, unknown>,
  fallbackId: string,
  fallbackSource: string
): TestCase {
  const id = typeof testCase.id === 'string' && testCase.id.trim() ? testCase.id.trim() : fallbackId;
  const priority = testCase.priority ?? 'Recommended';
  const title = (typeof testCase.title === 'string' && testCase.title.trim())
    ? testCase.title.trim()
    : (typeof testCase.text === 'string' && testCase.text.trim() ? testCase.text.trim() : 'Validate release behavior');
  const text = (typeof testCase.text === 'string' && testCase.text.trim()) ? testCase.text.trim() : title;
  const objective = (typeof testCase.objective === 'string' && testCase.objective.trim())
    ? testCase.objective.trim()
    : text;

  const preconditions = normalizeStringList(testCase.preconditions);
  const steps = normalizeStringList(testCase.steps);
  const expected = (typeof testCase.expected === 'string' && testCase.expected.trim())
    ? testCase.expected.trim()
    : DEFAULT_EXPECTED;

  const sourceRefs = uniq([
    ...normalizeStringList(testCase.sourceRefs),
    typeof testCase.source === 'string' ? testCase.source.trim() : '',
    fallbackSource,
  ].filter(Boolean));

  const source = (typeof testCase.source === 'string' && testCase.source.trim())
    ? testCase.source.trim()
    : sourceRefs[0] ?? fallbackSource;

  const rawTags = normalizeStringList(testCase.tags);
  const tags = uniq(
    [...rawTags.map(toTag).filter(Boolean), toTag(fallbackSource), toTag(priority), toTag(testCase.type ?? inferCaseType(priority))]
      .filter(Boolean)
  );

  return {
    id,
    text,
    title,
    objective,
    preconditions: preconditions.length ? preconditions : [DEFAULT_PRECONDITION],
    steps: steps.length ? steps : [`Run scenario: ${title}`],
    expected,
    priority,
    type: testCase.type ?? inferCaseType(priority),
    risk: testCase.risk ?? inferRisk(priority),
    source,
    sourceRefs: sourceRefs.length ? sourceRefs : [fallbackSource],
    tags: tags.length ? tags : ['release'],
  };
}

function normalizePlan(plan: TestPlan): TestPlan {
  let caseCounter = 1;
  return {
    sections: (plan.sections ?? []).map((section) => ({
      area: section.area,
      cases: (section.cases ?? []).map((testCase) => {
        const next = normalizeCase(
          testCase as Partial<TestCase> & Record<string, unknown>,
          `tc-${caseCounter}`,
          section.area
        );
        caseCounter += 1;
        return next;
      }),
    })),
  };
}

export class TestPlanAgent {
  private llm: LLMClient;

  constructor(llm?: LLMClient) {
    const client = llm ?? getLLMClient();
    if (!client) {
      throw new Error('LLM client not available. Check LLM_PROVIDER and related environment variables.');
    }
    this.llm = client;
  }

  /**
   * Generate a complete test plan based on changes and hotspots.
   */
  async generateTestPlan(changes: ChangeInput[], hotspots: Hotspot[]): Promise<TestPlan> {
    if (changes.length === 0) {
      return { sections: [] };
    }

    logger.debug({ changeCount: changes.length, hotspotCount: hotspots.length }, 'Generating test plan');

    const result = await this.llm.generateObject({
      schema: TestPlanSchema,
      messages: [
        { role: 'system', content: TEST_PLAN_SYSTEM_PROMPT },
        { role: 'user', content: buildTestPlanPrompt(changes, hotspots) },
      ],
      maxTokens: 4096,
      temperature: 0.35,
    });

    const normalized = normalizePlan(result);

    logger.info({
      sectionCount: normalized.sections.length,
      totalCases: normalized.sections.reduce((sum, s) => sum + s.cases.length, 0),
    }, 'Test plan generated');

    return normalized;
  }

  /**
   * Generate additional test cases for a specific area.
   * Useful when user wants more tests for a particular area.
   */
  async generateAreaTests(
    area: string,
    changes: ChangeInput[],
    existingCases: TestCase[]
  ): Promise<TestCase[]> {
    const areaChanges = changes.filter((c) => c.area === area);
    if (areaChanges.length === 0) {
      return [];
    }

    logger.debug({ area, changeCount: areaChanges.length }, 'Generating additional test cases');

    const existingTexts = existingCases.map((c) => `${c.title}: ${c.objective}`);

    const result = await this.llm.generateObject({
      schema: TestPlanSchema,
      messages: [
        { role: 'system', content: TEST_PLAN_SYSTEM_PROMPT },
        { role: 'user', content: buildAreaTestPrompt(area, changes, existingTexts) },
      ],
      maxTokens: 1400,
      temperature: 0.4,
    });

    // Extract cases for the requested area
    const areaCases = result.sections.find((s) => s.area === area)?.cases ?? [];

    // Add unique IDs
    const maxId = existingCases.reduce((max, c) => {
      const match = c.id.match(/tc-(\d+)/);
      return match ? Math.max(max, Number.parseInt(match[1], 10)) : max;
    }, 0);

    return areaCases.map((c, i) =>
      normalizeCase(
        c as Partial<TestCase> & Record<string, unknown>,
        c.id || `tc-${maxId + i + 1}`,
        area
      )
    );
  }

  /**
   * Generate test plan using heuristics (no LLM call).
   * Useful for quick previews or when LLM is not available.
   */
  generateTestPlanHeuristic(changes: ChangeInput[]): TestPlan {
    const sections = new Map<string, TestCase[]>();

    for (const change of changes) {
      const cases: TestCase[] = [];
      const source = `PR #${change.number}`;
      const tags = uniq([
        toTag(change.area),
        toTag(change.type),
        toTag(change.risk),
        ...(change.signals ?? []).map(toTag),
      ].filter(Boolean));

      if (change.type === 'New') {
        cases.push(normalizeCase({
          id: `tc-${change.number}-1`,
          text: `Core workflow works for: ${change.title}`,
          title: `Validate new behavior for PR #${change.number}`,
          objective: `Confirm the newly introduced behavior in "${change.title}" works end-to-end.`,
          preconditions: [DEFAULT_PRECONDITION, 'Required feature flags are enabled.'],
          steps: [
            'Navigate to the feature entry point.',
            'Execute the primary user flow introduced by this change.',
            'Repeat once with a different valid input path.',
          ],
          expected: 'The new flow completes successfully and reflects expected state in UI/API.',
          priority: 'Must',
          type: 'Functional',
          risk: change.risk,
          source,
          sourceRefs: [source, `Area: ${change.area}`],
          tags,
        }, `tc-${change.number}-1`, source));

        cases.push(normalizeCase({
          id: `tc-${change.number}-2`,
          text: `Invalid/edge input handling for: ${change.title}`,
          title: `Negative and edge handling for PR #${change.number}`,
          objective: 'Ensure invalid and boundary inputs are handled safely.',
          preconditions: [DEFAULT_PRECONDITION],
          steps: [
            'Repeat the primary flow with invalid input or boundary values.',
            'Observe error handling and system state.',
          ],
          expected: 'A clear error or guardrail appears and system state remains consistent.',
          priority: 'Recommended',
          type: 'Negative',
          risk: change.risk === 'High' ? 'High' : 'Medium',
          source,
          sourceRefs: [source, `Area: ${change.area}`],
          tags,
        }, `tc-${change.number}-2`, source));
      } else if (change.type === 'Fix') {
        cases.push(normalizeCase({
          id: `tc-${change.number}-1`,
          text: `Bug fix verification for: ${change.title}`,
          title: `Repro + verify fix for PR #${change.number}`,
          objective: 'Validate the reported defect is resolved.',
          preconditions: [DEFAULT_PRECONDITION, 'Use data/state that previously triggered the defect.'],
          steps: [
            'Run the same steps that reproduced the original bug.',
            'Repeat once after refresh/restart when applicable.',
          ],
          expected: 'The previous failure does not reproduce and output is correct.',
          priority: 'Must',
          type: 'Regression',
          risk: change.risk,
          source,
          sourceRefs: [source, `Area: ${change.area}`],
          tags,
        }, `tc-${change.number}-1`, source));

        cases.push(normalizeCase({
          id: `tc-${change.number}-2`,
          text: `Neighboring workflow regression for: ${change.title}`,
          title: `Adjacent workflow safety check for PR #${change.number}`,
          objective: 'Ensure the fix does not break related workflows.',
          preconditions: [DEFAULT_PRECONDITION],
          steps: [
            'Run one primary adjacent workflow in the same module.',
            'Run one integration touchpoint that depends on this behavior.',
          ],
          expected: 'Adjacent workflows remain functional and unchanged unless intended.',
          priority: 'Recommended',
          type: 'Integration',
          risk: change.risk === 'High' ? 'High' : 'Medium',
          source,
          sourceRefs: [source, `Area: ${change.area}`],
          tags,
        }, `tc-${change.number}-2`, source));
      } else {
        cases.push(normalizeCase({
          id: `tc-${change.number}-1`,
          text: `Behavior validation for: ${change.title}`,
          title: `Validate changed behavior for PR #${change.number}`,
          objective: 'Confirm behavior changes are intentional and stable.',
          preconditions: [DEFAULT_PRECONDITION],
          steps: [
            'Execute the changed workflow in a normal scenario.',
            'Verify any UI/state/output changes introduced by the PR.',
          ],
          expected: 'Changed behavior matches release expectations with no regressions.',
          priority: change.risk === 'High' ? 'Must' : 'Recommended',
          type: 'Functional',
          risk: change.risk,
          source,
          sourceRefs: [source, `Area: ${change.area}`],
          tags,
        }, `tc-${change.number}-1`, source));
      }

      const existing = sections.get(change.area) ?? [];
      sections.set(change.area, [...existing, ...cases]);
    }

    return {
      sections: Array.from(sections.entries()).map(([area, cases]) => ({
        area,
        cases,
      })),
    };
  }
}

// Singleton instance
let testPlanAgent: TestPlanAgent | null = null;

export function getTestPlanAgent(): TestPlanAgent | null {
  if (!testPlanAgent) {
    try {
      testPlanAgent = new TestPlanAgent();
    } catch (e) {
      logger.warn({ err: e }, 'Failed to create TestPlanAgent');
      return null;
    }
  }
  return testPlanAgent;
}
