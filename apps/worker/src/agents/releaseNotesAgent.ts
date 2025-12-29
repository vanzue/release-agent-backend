import pino from 'pino';
import { getLLMClient, type LLMClient } from '../llm.js';
import {
  CommitSummarySchema,
  BatchCommitSummarySchema,
  type CommitSummary,
  type BatchCommitSummary,
  type CommitInput,
  type PRInput,
} from './types.js';
import {
  RELEASE_NOTES_SYSTEM_PROMPT,
  buildCommitSummaryPrompt,
  buildPRSummaryPrompt,
  buildBatchCommitSummaryPrompt,
  buildRegeneratePrompt,
} from '../prompts/releaseNotes.js';

const logger = pino({
  name: 'release-notes-agent',
  level: process.env.LOG_LEVEL ?? 'info',
});

export class ReleaseNotesAgent {
  private llm: LLMClient;

  constructor(llm?: LLMClient) {
    const client = llm ?? getLLMClient();
    if (!client) {
      throw new Error('LLM client not available. Check LLM_PROVIDER and related environment variables.');
    }
    this.llm = client;
  }

  /**
   * Summarize a single commit for release notes.
   */
  async summarizeCommit(commit: CommitInput): Promise<CommitSummary> {
    logger.debug({ sha: commit.sha.slice(0, 7) }, 'Summarizing commit');

    const result = await this.llm.generateObject({
      schema: CommitSummarySchema,
      messages: [
        { role: 'system', content: RELEASE_NOTES_SYSTEM_PROMPT },
        { role: 'user', content: buildCommitSummaryPrompt(commit) },
      ],
      temperature: 0.3,
    });

    logger.debug({ sha: commit.sha.slice(0, 7), area: result.area, type: result.type }, 'Commit summarized');
    return result;
  }

  /**
   * Summarize a PR for release notes.
   */
  async summarizePR(pr: PRInput): Promise<CommitSummary> {
    logger.debug({ prNumber: pr.number }, 'Summarizing PR');

    const result = await this.llm.generateObject({
      schema: CommitSummarySchema,
      messages: [
        { role: 'system', content: RELEASE_NOTES_SYSTEM_PROMPT },
        { role: 'user', content: buildPRSummaryPrompt(pr) },
      ],
      temperature: 0.3,
    });

    logger.debug({ prNumber: pr.number, area: result.area, type: result.type }, 'PR summarized');
    return result;
  }

  /**
   * Batch summarize multiple commits in a single LLM call.
   * More efficient than calling summarizeCommit multiple times.
   */
  async summarizeCommitsBatch(commits: CommitInput[]): Promise<BatchCommitSummary> {
    if (commits.length === 0) {
      return { summaries: [] };
    }

    // For small batches, process individually for better quality
    if (commits.length <= 3) {
      const summaries = await Promise.all(
        commits.map(async (c) => {
          const result = await this.summarizeCommit(c);
          return {
            commitSha: c.sha,
            ...result,
          };
        })
      );
      return { summaries };
    }

    // For larger batches, use batch processing
    logger.debug({ count: commits.length }, 'Batch summarizing commits');

    const result = await this.llm.generateObject({
      schema: BatchCommitSummarySchema,
      messages: [
        { role: 'system', content: RELEASE_NOTES_SYSTEM_PROMPT },
        { role: 'user', content: buildBatchCommitSummaryPrompt(commits) },
      ],
      maxTokens: 4096,
      temperature: 0.3,
    });

    logger.debug({ count: result.summaries.length }, 'Batch summarization complete');
    return result;
  }

  /**
   * Regenerate a release note with potentially improved content.
   */
  async regenerate(
    originalText: string,
    commit: CommitInput,
    feedback?: string
  ): Promise<CommitSummary> {
    logger.debug({ sha: commit.sha.slice(0, 7) }, 'Regenerating release note');

    const result = await this.llm.generateObject({
      schema: CommitSummarySchema,
      messages: [
        { role: 'system', content: RELEASE_NOTES_SYSTEM_PROMPT },
        { role: 'user', content: buildRegeneratePrompt(originalText, commit, feedback) },
      ],
      temperature: 0.5, // Slightly higher temperature for variety
    });

    logger.debug({ sha: commit.sha.slice(0, 7), newSummary: result.summary.slice(0, 50) }, 'Release note regenerated');
    return result;
  }

  /**
   * Generate a simple summary without structured output (faster, cheaper).
   * Useful for quick previews or when structured data isn't needed.
   */
  async quickSummarize(message: string): Promise<string> {
    const result = await this.llm.chat({
      messages: [
        { role: 'system', content: 'You are a release notes writer. Convert commit messages into concise, user-friendly release notes. One sentence only.' },
        { role: 'user', content: `Commit message: ${message}\n\nRelease note:` },
      ],
      maxTokens: 100,
      temperature: 0.3,
    });

    return result.trim();
  }
}

// Singleton instance
let releaseNotesAgent: ReleaseNotesAgent | null = null;

export function getReleaseNotesAgent(): ReleaseNotesAgent | null {
  if (!releaseNotesAgent) {
    try {
      releaseNotesAgent = new ReleaseNotesAgent();
    } catch (e) {
      logger.warn({ err: e }, 'Failed to create ReleaseNotesAgent');
      return null;
    }
  }
  return releaseNotesAgent;
}
