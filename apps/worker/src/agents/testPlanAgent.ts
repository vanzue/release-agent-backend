import pino from 'pino';
import { getLLMClient, type LLMClient } from '../llm.js';
import {
  TestPlanSchema,
  type TestPlan,
  type ChangeInput,
  type Hotspot,
  type TestCase,
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
      temperature: 0.4,
    });

    // Add IDs to test cases if not present
    let caseCounter = 1;
    for (const section of result.sections) {
      for (const testCase of section.cases) {
        if (!testCase.id) {
          testCase.id = `tc-${caseCounter++}`;
        }
      }
    }

    logger.info({
      sectionCount: result.sections.length,
      totalCases: result.sections.reduce((sum, s) => sum + s.cases.length, 0),
    }, 'Test plan generated');

    return result;
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
    const areaChanges = changes.filter(c => c.area === area);
    if (areaChanges.length === 0) {
      return [];
    }

    logger.debug({ area, changeCount: areaChanges.length }, 'Generating additional test cases');

    const existingTexts = existingCases.map(c => c.text);

    const result = await this.llm.generateObject({
      schema: TestPlanSchema,
      messages: [
        { role: 'system', content: TEST_PLAN_SYSTEM_PROMPT },
        { role: 'user', content: buildAreaTestPrompt(area, changes, existingTexts) },
      ],
      maxTokens: 1024,
      temperature: 0.5,
    });

    // Extract cases for the requested area
    const areaCases = result.sections.find(s => s.area === area)?.cases ?? [];
    
    // Add unique IDs
    const maxId = existingCases.reduce((max, c) => {
      const match = c.id.match(/tc-(\d+)/);
      return match ? Math.max(max, parseInt(match[1], 10)) : max;
    }, 0);

    return areaCases.map((c, i) => ({
      ...c,
      id: c.id || `tc-${maxId + i + 1}`,
    }));
  }

  /**
   * Generate test plan using heuristics (no LLM call).
   * Useful for quick previews or when LLM is not available.
   */
  generateTestPlanHeuristic(changes: ChangeInput[]): TestPlan {
    const sections = new Map<string, TestCase[]>();

    for (const change of changes) {
      const cases: TestCase[] = [];
      
      // Generate test case based on change type
      if (change.type === 'New') {
        cases.push({
          id: `tc-${change.number}-1`,
          text: `Verify ${change.title.toLowerCase()} feature works as expected`,
          priority: 'Must',
          source: `PR #${change.number}`,
        });
        cases.push({
          id: `tc-${change.number}-2`,
          text: `Test ${change.title.toLowerCase()} with edge cases`,
          priority: 'Recommended',
          source: `PR #${change.number}`,
        });
      } else if (change.type === 'Fix') {
        cases.push({
          id: `tc-${change.number}-1`,
          text: `Verify the fix for: ${change.title}`,
          priority: 'Must',
          source: `PR #${change.number}`,
        });
        cases.push({
          id: `tc-${change.number}-2`,
          text: `Regression test related functionality after fix`,
          priority: 'Recommended',
          source: `PR #${change.number}`,
        });
      } else {
        cases.push({
          id: `tc-${change.number}-1`,
          text: `Verify ${change.title.toLowerCase()} change works correctly`,
          priority: change.risk === 'High' ? 'Must' : 'Recommended',
          source: `PR #${change.number}`,
        });
      }

      // Add to section
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
