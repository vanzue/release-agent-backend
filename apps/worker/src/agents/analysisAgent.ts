import pino from 'pino';
import { z } from 'zod';
import { getLLMClient, type LLMClient } from '../llm.js';
import {
  AnalysisResultSchema,
  SecuritySeveritySchema,
  type AnalysisResult,
  type ChangeInput,
  type SecuritySeverity,
} from './types.js';
import {
  ANALYSIS_SYSTEM_PROMPT,
  buildAnalysisPrompt,
  buildSecurityScanPrompt,
} from '../prompts/analysis.js';

const logger = pino({
  name: 'analysis-agent',
  level: process.env.LOG_LEVEL ?? 'info',
});

const SecurityScanResultSchema = z.object({
  severity: SecuritySeveritySchema,
  issues: z.array(z.object({
    type: z.string(),
    description: z.string(),
    recommendation: z.string(),
  })),
});

type SecurityScanResult = z.infer<typeof SecurityScanResultSchema>;

export class AnalysisAgent {
  private llm: LLMClient;

  constructor(llm?: LLMClient) {
    const client = llm ?? getLLMClient();
    if (!client) {
      throw new Error('LLM client not available. Check LLM_PROVIDER and related environment variables.');
    }
    this.llm = client;
  }

  /**
   * Analyze all changes and produce hotspots, security issues, and risk assessment.
   */
  async analyzeChanges(changes: ChangeInput[]): Promise<AnalysisResult> {
    if (changes.length === 0) {
      return {
        hotspots: [],
        securityIssues: [],
        overallRiskLevel: 'Low',
        riskSummary: 'No changes to analyze.',
      };
    }

    logger.debug({ changeCount: changes.length }, 'Analyzing changes');

    const result = await this.llm.generateObject({
      schema: AnalysisResultSchema,
      messages: [
        { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
        { role: 'user', content: buildAnalysisPrompt(changes) },
      ],
      maxTokens: 2048,
      temperature: 0.3,
    });

    logger.info({
      hotspotCount: result.hotspots.length,
      securityIssueCount: result.securityIssues.length,
      overallRisk: result.overallRiskLevel,
    }, 'Analysis complete');

    return result;
  }

  /**
   * Quick security scan of a specific diff.
   * Returns security severity and any issues found.
   */
  async scanSecurity(diff: string, context: string): Promise<SecurityScanResult> {
    logger.debug({ contextLength: context.length, diffLength: diff.length }, 'Scanning for security issues');

    const result = await this.llm.generateObject({
      schema: SecurityScanResultSchema,
      messages: [
        { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
        { role: 'user', content: buildSecurityScanPrompt(diff, context) },
      ],
      maxTokens: 1024,
      temperature: 0.2,
    });

    if (result.severity !== 'none') {
      logger.warn({ severity: result.severity, issueCount: result.issues.length }, 'Security issues found');
    }

    return result;
  }

  /**
   * Calculate risk score for a change based on heuristics.
   * This is a fast, non-LLM calculation for initial filtering.
   */
  calculateRiskScore(change: ChangeInput): number {
    let score = 0;

    // File count risk
    if (change.filesChanged >= 20) score += 30;
    else if (change.filesChanged >= 10) score += 20;
    else if (change.filesChanged >= 5) score += 10;

    // Churn risk
    const churn = change.additions + change.deletions;
    if (churn >= 2000) score += 30;
    else if (churn >= 500) score += 20;
    else if (churn >= 100) score += 10;

    // Signal-based risk
    const signalScores: Record<string, number> = {
      'Installer': 15,
      'Settings': 10,
      'Security': 25,
      'Auth': 25,
      'Build system': 10,
      'UI': 5,
    };

    for (const signal of change.signals) {
      score += signalScores[signal] ?? 5;
    }

    // Type-based risk
    if (change.type === 'New') score += 10;
    else if (change.type === 'Fix') score += 5;

    // Cap at 100
    return Math.min(score, 100);
  }

  /**
   * Generate hotspots using heuristics (no LLM call).
   * Useful for fast previews before full analysis.
   */
  generateHotspotsHeuristic(changes: ChangeInput[]): Array<{
    area: string;
    score: number;
    drivers: string[];
    contributingPrs: number[];
  }> {
    // Group by area
    const byArea = new Map<string, {
      changes: ChangeInput[];
      totalScore: number;
      drivers: Set<string>;
    }>();

    for (const change of changes) {
      const score = this.calculateRiskScore(change);
      const existing = byArea.get(change.area);

      if (existing) {
        existing.changes.push(change);
        existing.totalScore += score;
        if (change.risk === 'High') existing.drivers.add('High-risk changes');
        if (change.filesChanged >= 10) existing.drivers.add('Large changes');
        for (const signal of change.signals) {
          existing.drivers.add(signal);
        }
      } else {
        const drivers = new Set<string>();
        if (change.risk === 'High') drivers.add('High-risk changes');
        if (change.filesChanged >= 10) drivers.add('Large changes');
        for (const signal of change.signals) {
          drivers.add(signal);
        }

        byArea.set(change.area, {
          changes: [change],
          totalScore: score,
          drivers,
        });
      }
    }

    // Convert to hotspots and sort by score
    const hotspots = Array.from(byArea.entries())
      .map(([area, data]) => ({
        area,
        score: Math.min(Math.round(data.totalScore / data.changes.length + data.changes.length * 5), 100),
        drivers: Array.from(data.drivers),
        contributingPrs: data.changes.map(c => c.number),
      }))
      .sort((a, b) => b.score - a.score);

    return hotspots;
  }
}

// Singleton instance
let analysisAgent: AnalysisAgent | null = null;

export function getAnalysisAgent(): AnalysisAgent | null {
  if (!analysisAgent) {
    try {
      analysisAgent = new AnalysisAgent();
    } catch (e) {
      logger.warn({ err: e }, 'Failed to create AnalysisAgent');
      return null;
    }
  }
  return analysisAgent;
}
