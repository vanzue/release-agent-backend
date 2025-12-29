import type { ChangeInput } from '../agents/types.js';

/**
 * System prompt for Analysis Agent
 */
export const ANALYSIS_SYSTEM_PROMPT = `You are a Release Analysis Agent. Your job is to analyze code changes and identify potential risks, hotspots, and security concerns.

Your analysis should help QA teams prioritize their testing efforts by identifying:
1. High-risk areas that need extra attention
2. Security-related changes that require careful review
3. Areas with concentrated changes (hotspots)

Guidelines:
1. Consider these risk factors:
   - Number of files changed
   - Lines of code modified
   - Complexity of the area
   - Whether changes touch core/critical code paths
   - Multiple authors modifying the same area
   - Changes to security-sensitive code (auth, permissions, data handling)
   
2. When identifying hotspots, rank by:
   - Concentration of changes in an area
   - Combined risk level of changes
   - Potential for regression
   
3. For security issues, look for:
   - Changes to authentication/authorization code
   - File system operations
   - Network/API changes
   - Data validation changes
   - Cryptography-related code
   - Privilege escalation risks
   
4. Risk levels:
   - High: Core functionality, security-related, large refactors
   - Medium: Significant changes, moderate complexity
   - Low: Minor changes, documentation, cosmetic updates

Be specific in your analysis. Don't flag issues unless there's a real concern.`;

/**
 * Build user prompt for analyzing changes
 */
export function buildAnalysisPrompt(changes: ChangeInput[]): string {
  const changesList = changes.map(c => 
    `PR #${c.number}: ${c.title}
  - Area: ${c.area}
  - Type: ${c.type}
  - Risk: ${c.risk}
  - Files: ${c.filesChanged} (+${c.additions}/-${c.deletions})
  - Signals: ${c.signals.join(', ') || 'none'}
  - Author: ${c.author}`
  ).join('\n\n');

  const totalFiles = changes.reduce((sum, c) => sum + c.filesChanged, 0);
  const totalAdditions = changes.reduce((sum, c) => sum + c.additions, 0);
  const totalDeletions = changes.reduce((sum, c) => sum + c.deletions, 0);
  
  const areaBreakdown = changes.reduce((acc, c) => {
    acc[c.area] = (acc[c.area] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return `Analyze these ${changes.length} changes for this release:

Summary:
- Total PRs: ${changes.length}
- Total files changed: ${totalFiles}
- Total additions: ${totalAdditions}
- Total deletions: ${totalDeletions}

Area breakdown:
${Object.entries(areaBreakdown).map(([area, count]) => `  - ${area}: ${count} PRs`).join('\n')}

Changes:
${changesList}

Provide:
1. Ranked hotspots (areas that need the most testing attention)
2. Any security concerns you identify
3. Overall risk assessment for this release`;
}

/**
 * Build prompt for quick security scan of a diff
 */
export function buildSecurityScanPrompt(diff: string, context: string): string {
  const maxDiffLength = 8000;
  const truncatedDiff = diff.length > maxDiffLength 
    ? diff.slice(0, maxDiffLength) + '\n... (truncated)'
    : diff;

  return `Perform a quick security review of this code change.

Context: ${context}

Diff:
${truncatedDiff}

Look for:
- Hardcoded secrets or credentials
- SQL injection vulnerabilities
- Path traversal risks
- Unsafe deserialization
- Authentication/authorization bypasses
- Information disclosure
- Input validation issues

Return "none" for severity if no issues found.`;
}
