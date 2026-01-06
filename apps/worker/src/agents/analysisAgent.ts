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
    // Extra data for LLM enhancement
    _meta?: {
      prCount: number;
      totalFiles: number;
      totalChurn: number;
      highRiskCount: number;
      signals: string[];
    };
  }> {
    // Group by area
    const byArea = new Map<string, {
      changes: ChangeInput[];
      totalScore: number;
      drivers: Set<string>;
      totalFiles: number;
      totalChurn: number;
      highRiskCount: number;
    }>();

    for (const change of changes) {
      const score = this.calculateRiskScore(change);
      const existing = byArea.get(change.area);
      const churn = change.additions + change.deletions;

      if (existing) {
        existing.changes.push(change);
        existing.totalScore += score;
        existing.totalFiles += change.filesChanged;
        existing.totalChurn += churn;
        if (change.risk === 'High') existing.highRiskCount++;
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
          totalFiles: change.filesChanged,
          totalChurn: churn,
          highRiskCount: change.risk === 'High' ? 1 : 0,
        });
      }
    }

    // Convert to hotspots and sort by score
    const hotspots = Array.from(byArea.entries())
      .map(([area, data]) => ({
        area,
        score: Math.min(Math.round(data.totalScore / data.changes.length + data.changes.length * 5), 100),
        drivers: Array.from(data.drivers).slice(0, 5),
        contributingPrs: data.changes.map(c => c.number).slice(0, 10),
        _meta: {
          prCount: data.changes.length,
          totalFiles: data.totalFiles,
          totalChurn: data.totalChurn,
          highRiskCount: data.highRiskCount,
          signals: Array.from(data.drivers),
        },
      }))
      .sort((a, b) => b.score - a.score);

    return hotspots;
  }

  /**
   * Enhance a single hotspot with LLM-generated driver descriptions.
   * Takes heuristic data and generates more meaningful explanations.
   */
  async enhanceHotspotDrivers(hotspot: {
    area: string;
    score: number;
    _meta?: {
      prCount: number;
      totalFiles: number;
      totalChurn: number;
      highRiskCount: number;
      signals: string[];
    };
  }): Promise<string[]> {
    if (!hotspot._meta) {
      return ['Changes detected in this area'];
    }

    const { prCount, totalFiles, totalChurn, highRiskCount, signals } = hotspot._meta;

    const DriversSchema = z.object({
      drivers: z.array(z.string()).max(4).describe('Concise reasons why this area needs testing attention'),
    });

    try {
      const result = await this.llm.generateObject({
        schema: DriversSchema,
        messages: [
          {
            role: 'system',
            content: 'Generate 2-4 concise testing priority reasons for a code area. Each reason should be 5-15 words. Focus on actionable testing guidance.',
          },
          {
            role: 'user',
            content: `Area: ${hotspot.area}
Stats: ${prCount} PRs, ${totalFiles} files changed, ${totalChurn} lines modified
High-risk changes: ${highRiskCount}
Signals: ${signals.join(', ') || 'none'}
Risk score: ${hotspot.score}/100

Generate 2-4 concise reasons why QA should prioritize testing this area.`,
          },
        ],
        maxTokens: 200,
        temperature: 0.3,
      });

      return result.drivers;
    } catch (error) {
      logger.warn({ err: error, area: hotspot.area }, 'Failed to enhance hotspot drivers');
      // Fallback to basic drivers
      return this.generateBasicDrivers(hotspot._meta);
    }
  }

  /**
   * Generate basic driver descriptions from metadata (no LLM).
   */
  private generateBasicDrivers(meta: {
    prCount: number;
    totalFiles: number;
    totalChurn: number;
    highRiskCount: number;
    signals: string[];
  }): string[] {
    const drivers: string[] = [];
    
    if (meta.prCount >= 5) drivers.push(`${meta.prCount} PRs concentrated in this area`);
    else if (meta.prCount > 1) drivers.push(`${meta.prCount} PRs in this area`);
    
    if (meta.highRiskCount > 0) drivers.push(`${meta.highRiskCount} high-risk change(s)`);
    if (meta.totalFiles >= 20) drivers.push(`${meta.totalFiles} files modified`);
    if (meta.totalChurn >= 1000) drivers.push(`${meta.totalChurn} lines of code changed`);
    
    for (const signal of meta.signals.slice(0, 2)) {
      if (!['High-risk changes', 'Large changes'].includes(signal)) {
        drivers.push(`Touches ${signal.toLowerCase()} code`);
      }
    }
    
    return drivers.slice(0, 4);
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
