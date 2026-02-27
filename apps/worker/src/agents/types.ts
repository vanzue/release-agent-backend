import { z } from 'zod';

// ============================================
// Release Notes Agent Types
// ============================================

export const ChangeTypeSchema = z.enum(['New', 'Fix', 'Change']);
export type ChangeType = z.infer<typeof ChangeTypeSchema>;

export const CommitSummarySchema = z.object({
  summary: z.string().describe('A concise, user-friendly description of the change for release notes'),
  area: z.string().describe('The product area or module this change belongs to'),
  type: ChangeTypeSchema.describe('The type of change: New feature, Bug fix, or General change'),
});
export type CommitSummary = z.infer<typeof CommitSummarySchema>;

export const BatchCommitSummarySchema = z.object({
  summaries: z.array(
    z.object({
      commitSha: z.string(),
      summary: z.string(),
      area: z.string(),
      type: ChangeTypeSchema,
    })
  ),
});
export type BatchCommitSummary = z.infer<typeof BatchCommitSummarySchema>;

// ============================================
// Analysis Agent Types
// ============================================

export const RiskLevelSchema = z.enum(['High', 'Medium', 'Low']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const SecuritySeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'none']);
export type SecuritySeverity = z.infer<typeof SecuritySeveritySchema>;

export const HotspotSchema = z.object({
  area: z.string().describe('The product area or module'),
  score: z.number().min(0).max(100).describe('Risk score from 0-100'),
  drivers: z.array(z.string()).describe('Reasons why this area is high risk'),
  contributingPrs: z.array(z.number()).describe('PR numbers contributing to this hotspot'),
});
export type Hotspot = z.infer<typeof HotspotSchema>;

export const AnalysisResultSchema = z.object({
  hotspots: z.array(HotspotSchema).describe('Ranked list of high-risk areas'),
  securityIssues: z.array(
    z.object({
      severity: SecuritySeveritySchema,
      description: z.string(),
      affectedPrs: z.array(z.number()),
      recommendation: z.string(),
    })
  ).describe('Security-related concerns found in the changes'),
  overallRiskLevel: RiskLevelSchema.describe('Overall risk assessment for this release'),
  riskSummary: z.string().describe('Brief summary of the risk assessment'),
});
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

// ============================================
// Test Plan Agent Types
// ============================================

export const TestPrioritySchema = z.enum(['Must', 'Recommended', 'Exploratory']);
export type TestPriority = z.infer<typeof TestPrioritySchema>;

export const TestCaseTypeSchema = z.enum([
  'Functional',
  'Regression',
  'Negative',
  'Integration',
  'Security',
  'Performance',
  'Exploratory',
]);
export type TestCaseType = z.infer<typeof TestCaseTypeSchema>;

export const TestCaseSchema = z.object({
  id: z.string(),
  text: z.string().describe('Short one-line summary of the test case'),
  title: z.string().describe('Readable scenario title'),
  objective: z.string().describe('What risk or behavior this test validates'),
  preconditions: z.array(z.string()).describe('Setup or prerequisite state before execution'),
  steps: z.array(z.string()).describe('Ordered test steps the tester should run'),
  expected: z.string().describe('Expected outcome to validate pass/fail'),
  priority: TestPrioritySchema.describe('Test priority level'),
  type: TestCaseTypeSchema.describe('Type of testing required'),
  risk: RiskLevelSchema.describe('Risk level if this test fails'),
  source: z.string().describe('Primary source PR or area'),
  sourceRefs: z.array(z.string()).describe('Related PRs or areas that motivated this case'),
  tags: z.array(z.string()).describe('Short labels for filtering/grouping'),
});
export type TestCase = z.infer<typeof TestCaseSchema>;

export const TestPlanSectionSchema = z.object({
  area: z.string(),
  cases: z.array(TestCaseSchema),
});
export type TestPlanSection = z.infer<typeof TestPlanSectionSchema>;

export const TestPlanSchema = z.object({
  sections: z.array(TestPlanSectionSchema),
});
export type TestPlan = z.infer<typeof TestPlanSchema>;

// ============================================
// Input Types (for agents)
// ============================================

export interface CommitInput {
  sha: string;
  message: string;
  author: string | null;
  diff?: string; // Optional: full diff content for small changes
  // PR context (if commit is associated with a PR)
  prNumber?: number;
  prTitle?: string;
  prDescription?: string; // PR body/description for large PRs
  prLabels?: string[];
  filesChanged?: number;
  additions?: number;
  deletions?: number;
}

export interface PRInput {
  number: number;
  title: string;
  body: string | null;
  author: string;
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
  }>;
  labels: string[];
}

export interface ChangeInput {
  id: string;
  title: string;
  number: number;
  author: string;
  area: string;
  type: ChangeType;
  risk: RiskLevel;
  filesChanged: number;
  additions: number;
  deletions: number;
  signals: string[];
}
