import type { CommitInput, PRInput } from '../agents/types.js';

/**
 * System prompt for Release Notes Agent
 */
export const RELEASE_NOTES_SYSTEM_PROMPT = `You are a Release Notes Agent for a software project. Your job is to convert code changes into clear, concise, and user-friendly release notes.

Guidelines:
1. Write summaries that end users can understand - avoid internal jargon
2. Focus on WHAT changed and WHY it matters to users, not HOW it was implemented
3. Keep summaries concise (one sentence, max 100 characters if possible)
4. Start with an action verb when appropriate (Added, Fixed, Improved, etc.)
5. Properly categorize changes:
   - "New" = new features, capabilities, or tools
   - "Fix" = bug fixes, crash fixes, regressions
   - "Change" = improvements, refactoring, updates, dependency changes
6. Identify the correct product area based on:
   - File paths in the change
   - Keywords in commit messages
   - Labels on PRs
7. Do not include PR/issue numbers in the summary text
8. Do not include author information in the summary text

Product Areas (use these exact names when applicable):
- Advanced Paste, Always On Top, Awake, Color Picker, Command Not Found
- Crop And Lock, Environment Variables, FancyZones, File Explorer Add-ons
- File Locksmith, Find My Mouse, Hosts File Editor, Image Resizer
- Keyboard Manager, Mouse Jump, Mouse Pointer Crosshairs, Mouse Without Borders
- New+, Peek, PowerRename, PowerToys Run, Quick Accent, Registry Preview
- Screen Ruler, Settings, Shortcut Guide, Text Extractor, Video Conference Mute
- Workspaces, ZoomIt, Installer, Development, Documentation

If the change doesn't clearly belong to a specific tool, use:
- "Development" for build system, CI/CD, code refactoring
- "Documentation" for doc changes
- "Settings" for settings-related changes
- "General" as last resort`;

/**
 * Build user prompt for summarizing a single commit
 */
export function buildCommitSummaryPrompt(commit: CommitInput): string {
  let prompt = `Summarize this commit for release notes:

Commit SHA: ${commit.sha.slice(0, 7)}
Author: ${commit.author ?? 'unknown'}
Message:
${commit.message}`;

  if (commit.diff) {
    // Truncate diff if too long
    const maxDiffLength = 3000;
    const truncatedDiff = commit.diff.length > maxDiffLength 
      ? commit.diff.slice(0, maxDiffLength) + '\n... (truncated)'
      : commit.diff;
    prompt += `\n\nDiff:\n${truncatedDiff}`;
  }

  return prompt;
}

/**
 * Build user prompt for summarizing a PR
 */
export function buildPRSummaryPrompt(pr: PRInput): string {
  const filesList = pr.files
    .slice(0, 20) // Limit to first 20 files
    .map(f => `  - ${f.path} (+${f.additions}/-${f.deletions})`)
    .join('\n');

  return `Summarize this Pull Request for release notes:

PR #${pr.number}: ${pr.title}
Author: ${pr.author}
Labels: ${pr.labels.join(', ') || 'none'}

Description:
${pr.body || '(no description)'}

Files changed (${pr.files.length} total):
${filesList}${pr.files.length > 20 ? '\n  ... and more' : ''}`;
}

/**
 * Build user prompt for batch summarizing commits
 */
export function buildBatchCommitSummaryPrompt(commits: CommitInput[]): string {
  const commitsList = commits.map((c, i) => 
    `[${i + 1}] SHA: ${c.sha.slice(0, 7)}
Author: ${c.author ?? 'unknown'}
Message: ${c.message.split('\n')[0]}`
  ).join('\n\n');

  return `Summarize these ${commits.length} commits for release notes. For each commit, provide a summary, area, and type.

${commitsList}`;
}

/**
 * Build prompt for regenerating a release note
 */
export function buildRegeneratePrompt(
  originalText: string,
  commit: CommitInput,
  feedback?: string
): string {
  let prompt = `Regenerate this release note with a better summary.

Original release note:
"${originalText}"

Commit information:
SHA: ${commit.sha.slice(0, 7)}
Author: ${commit.author ?? 'unknown'}
Message:
${commit.message}`;

  if (commit.diff) {
    const maxDiffLength = 3000;
    const truncatedDiff = commit.diff.length > maxDiffLength 
      ? commit.diff.slice(0, maxDiffLength) + '\n... (truncated)'
      : commit.diff;
    prompt += `\n\nDiff:\n${truncatedDiff}`;
  }

  if (feedback) {
    prompt += `\n\nUser feedback for improvement:\n${feedback}`;
  }

  return prompt;
}
