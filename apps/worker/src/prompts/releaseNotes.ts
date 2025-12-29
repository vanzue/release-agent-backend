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
 * Build user prompt for summarizing a single commit.
 * Strategy:
 * - For large PRs (many files/changes): use PR description as context
 * - For small changes: use diff directly for detailed understanding
 */
export function buildCommitSummaryPrompt(commit: CommitInput): string {
  let prompt = `Summarize this commit for release notes:

Commit SHA: ${commit.sha.slice(0, 7)}
Author: ${commit.author ?? 'unknown'}
Message:
${commit.message}`;

  // Add PR context if available
  if (commit.prNumber) {
    prompt += `\n\nAssociated PR: #${commit.prNumber}`;
    if (commit.prTitle) {
      prompt += `\nPR Title: ${commit.prTitle}`;
    }
    if (commit.prLabels && commit.prLabels.length > 0) {
      prompt += `\nLabels: ${commit.prLabels.join(', ')}`;
    }
    if (commit.filesChanged !== undefined) {
      prompt += `\nFiles changed: ${commit.filesChanged} (+${commit.additions ?? 0}/-${commit.deletions ?? 0})`;
    }
  }

  // For large PRs, prefer PR description; for small changes, use diff
  const isLargePR = (commit.filesChanged ?? 0) > 10 || (commit.additions ?? 0) + (commit.deletions ?? 0) > 500;
  
  if (isLargePR && commit.prDescription) {
    // Large PR: use description which typically summarizes the changes well
    const maxDescLength = 2000;
    const truncatedDesc = commit.prDescription.length > maxDescLength
      ? commit.prDescription.slice(0, maxDescLength) + '\n... (truncated)'
      : commit.prDescription;
    prompt += `\n\nPR Description:\n${truncatedDesc}`;
  } else if (commit.diff) {
    // Small change: use diff for detailed context
    const maxDiffLength = 3000;
    const truncatedDiff = commit.diff.length > maxDiffLength 
      ? commit.diff.slice(0, maxDiffLength) + '\n... (truncated)'
      : commit.diff;
    prompt += `\n\nDiff:\n${truncatedDiff}`;
  } else if (commit.prDescription) {
    // Fallback: use description if no diff available
    const maxDescLength = 2000;
    const truncatedDesc = commit.prDescription.length > maxDescLength
      ? commit.prDescription.slice(0, maxDescLength) + '\n... (truncated)'
      : commit.prDescription;
    prompt += `\n\nPR Description:\n${truncatedDesc}`;
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
 * Build user prompt for batch summarizing commits.
 * Includes PR context when available for better understanding.
 */
export function buildBatchCommitSummaryPrompt(commits: CommitInput[]): string {
  const commitsList = commits.map((c, i) => {
    let entry = `[${i + 1}] SHA: ${c.sha.slice(0, 7)}
Author: ${c.author ?? 'unknown'}
Message: ${c.message.split('\n')[0]}`;

    // Add PR context if available
    if (c.prNumber) {
      entry += `\nPR: #${c.prNumber}`;
      if (c.prTitle && c.prTitle !== c.message.split('\n')[0]) {
        entry += ` - ${c.prTitle}`;
      }
      if (c.prLabels && c.prLabels.length > 0) {
        entry += `\nLabels: ${c.prLabels.join(', ')}`;
      }
      if (c.filesChanged !== undefined) {
        entry += `\nScope: ${c.filesChanged} files (+${c.additions ?? 0}/-${c.deletions ?? 0})`;
      }
    }

    // Add context based on size
    const isLargePR = (c.filesChanged ?? 0) > 10 || (c.additions ?? 0) + (c.deletions ?? 0) > 500;
    if (isLargePR && c.prDescription) {
      // For large PRs, include truncated description
      const maxDescLength = 500; // Shorter for batch mode
      const truncatedDesc = c.prDescription.length > maxDescLength
        ? c.prDescription.slice(0, maxDescLength) + '...'
        : c.prDescription;
      entry += `\nDescription: ${truncatedDesc}`;
    } else if (c.diff) {
      // For small changes, include truncated diff
      const maxDiffLength = 800; // Shorter for batch mode
      const truncatedDiff = c.diff.length > maxDiffLength
        ? c.diff.slice(0, maxDiffLength) + '...'
        : c.diff;
      entry += `\nDiff:\n${truncatedDiff}`;
    } else if (c.prDescription) {
      // Fallback to description
      const maxDescLength = 500;
      const truncatedDesc = c.prDescription.length > maxDescLength
        ? c.prDescription.slice(0, maxDescLength) + '...'
        : c.prDescription;
      entry += `\nDescription: ${truncatedDesc}`;
    }

    return entry;
  }).join('\n\n---\n\n');

  return `Summarize these ${commits.length} commits for release notes. For each commit, provide a summary, area, and type.

IMPORTANT: Generate user-friendly summaries that explain WHAT changed and WHY it matters, not just repeat the commit message.

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

  // Add PR context if available (for better understanding)
  if (commit.prNumber) {
    prompt += `\n\nPull Request: #${commit.prNumber}`;
    if (commit.prTitle) {
      prompt += `\nPR Title: ${commit.prTitle}`;
    }
    if (commit.prLabels && commit.prLabels.length > 0) {
      prompt += `\nLabels: ${commit.prLabels.join(', ')}`;
    }
    if (commit.filesChanged !== undefined) {
      prompt += `\nFiles changed: ${commit.filesChanged}, +${commit.additions ?? 0}/-${commit.deletions ?? 0} lines`;
    }
  }

  // For large PRs with description, use PR description as primary context
  const isLargePR = (commit.filesChanged ?? 0) > 10 || ((commit.additions ?? 0) + (commit.deletions ?? 0)) > 500;
  
  if (commit.prDescription && commit.prDescription.length > 50 && isLargePR) {
    const maxDescLength = 2000;
    const truncatedDesc = commit.prDescription.length > maxDescLength
      ? commit.prDescription.slice(0, maxDescLength) + '\n... (truncated)'
      : commit.prDescription;
    prompt += `\n\nPR Description (use this for context on large changes):\n${truncatedDesc}`;
  } else if (commit.diff) {
    // For smaller changes, use diff for detailed understanding
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
