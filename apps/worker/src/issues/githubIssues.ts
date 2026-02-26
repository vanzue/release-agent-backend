import pino from 'pino';
import type { GithubIssue, GithubRelease } from './types.js';
import {
  isHttpRateLimitError,
  getRetryDelayFromHeaders,
  sleep,
  calculateBackoff,
  type RetryConfig,
} from '../retry.js';

const logger = pino({ name: 'github-issues', level: process.env.LOG_LEVEL ?? 'info' });

class GithubApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GithubApiError';
    this.status = status;
  }
}

function requireGithubToken() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('Missing GITHUB_TOKEN');
  return token;
}

function parseRepoFullName(repoFullName: string) {
  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) throw new Error(`Invalid repoFullName: ${repoFullName}`);
  return { owner, repo };
}

// Response type that includes Link header for pagination info
type GitHubResponse<T> = {
  data: T;
  linkHeader: string | null;
};

// GitHub-specific retry configuration
const GITHUB_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 6,
  initialDelayMs: 5000,
  maxDelayMs: 120000,
  backoffMultiplier: 2,
  jitter: true,
};

async function githubRequestWithHeaders<T>(path: string, init?: any): Promise<GitHubResponse<T>> {
  const token = requireGithubToken();
  const config = GITHUB_RETRY_CONFIG;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    const res: any = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        ...(init?.headers ?? {}),
      },
    });

    if (res.ok) {
      return {
        data: (await res.json()) as T,
        linkHeader: res.headers.get('link'),
      };
    }

    const text = await res.text().catch(() => '');

    if (isHttpRateLimitError(res.status, text)) {
      if (attempt < config.maxAttempts) {
        const retryAfterMs = getRetryDelayFromHeaders(res.headers, config.maxDelayMs);
        const delayMs = calculateBackoff(attempt, config, retryAfterMs);

        logger.warn(
          { path, attempt, maxAttempts: config.maxAttempts, delayMs: Math.round(delayMs) },
          'Rate limited, waiting before retry'
        );
        await sleep(delayMs);
        continue;
      }
      throw new Error(`GitHub API rate limit exceeded after ${config.maxAttempts} attempts: ${text}`);
    } else {
      throw new GithubApiError(res.status, `GitHub API error ${res.status} ${res.statusText}: ${text}`);
    }
  }

  throw new Error('GitHub API request failed after retries');
}

async function githubRequest<T>(path: string, init?: any): Promise<T> {
  const result = await githubRequestWithHeaders<T>(path, init);
  return result.data;
}

// Parse last page number from Link header
function parseLastPageFromLink(linkHeader: string | null): number | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/page=(\d+)>;\s*rel="last"/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function getMaxPages(): number {
  const raw = Number.parseInt(process.env.ISSUE_SYNC_MAX_PAGES ?? '', 10);
  // Default to Infinity (no limit) - pagination will stop when batch.length < perPage
  return Number.isFinite(raw) && raw > 0 ? raw : Infinity;
}

async function listIssues(options: {
  repoFullName: string;
  state: 'open' | 'all';
  since?: string | null;
  sort: 'updated' | 'created';
  direction: 'asc' | 'desc';
  perPage?: number;
  maxPages?: number;
}): Promise<GithubIssue[]> {
  const { owner, repo } = parseRepoFullName(options.repoFullName);

  const issues: GithubIssue[] = [];
  const perPage = options.perPage ?? 100;
  const maxPages = options.maxPages ?? getMaxPages();

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams();
    params.set('state', options.state);
    params.set('per_page', String(perPage));
    params.set('page', String(page));
    params.set('sort', options.sort);
    params.set('direction', options.direction);
    if (options.since) params.set('since', options.since);

    logger.info({ repoFullName: options.repoFullName, page, maxPages, issuesSoFar: issues.length }, 'Fetching issues page');
    const batch = await githubRequest<GithubIssue[]>(`/repos/${owner}/${repo}/issues?${params.toString()}`);
    issues.push(...(batch ?? []));
    logger.info({ repoFullName: options.repoFullName, page, batchSize: batch?.length ?? 0, totalFetched: issues.length }, 'Fetched issues page');
    if (!batch || batch.length < perPage) break;
  }

  // Filter out PRs (GitHub issues API returns PRs with a pull_request field)
  return issues.filter((i) => !('pull_request' in i));
}

// Streaming version - yields each page of issues as they are fetched
// Also yields estimated total count based on Link header
export type StreamBatch = {
  issues: GithubIssue[];
  page: number;
  estimatedTotalPages: number | null;
  estimatedTotalIssues: number | null;
};

async function* streamIssues(options: {
  repoFullName: string;
  state: 'open' | 'all';
  since?: string | null;
  sort: 'updated' | 'created';
  direction: 'asc' | 'desc';
  perPage?: number;
  maxPages?: number;
}): AsyncGenerator<StreamBatch, void, unknown> {
  const { owner, repo } = parseRepoFullName(options.repoFullName);

  const perPage = options.perPage ?? 100;
  const maxPages = options.maxPages ?? getMaxPages();
  let totalFetched = 0;
  let estimatedTotalPages: number | null = null;

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams();
    params.set('state', options.state);
    params.set('per_page', String(perPage));
    params.set('page', String(page));
    params.set('sort', options.sort);
    params.set('direction', options.direction);
    if (options.since) params.set('since', options.since);

    logger.info({ repoFullName: options.repoFullName, page, estimatedTotalPages, issuesSoFar: totalFetched }, 'Fetching issues page');
    const response = await githubRequestWithHeaders<GithubIssue[]>(`/repos/${owner}/${repo}/issues?${params.toString()}`);
    
    // Parse total pages from Link header on first request
    if (page === 1) {
      estimatedTotalPages = parseLastPageFromLink(response.linkHeader);
      if (estimatedTotalPages) {
        logger.info({ repoFullName: options.repoFullName, estimatedTotalPages, estimatedTotalIssues: estimatedTotalPages * perPage }, 'Estimated total from Link header');
      }
    }
    
    // Filter out PRs
    const issues = (response.data ?? []).filter((i) => !('pull_request' in i));
    totalFetched += issues.length;
    
    logger.info({ repoFullName: options.repoFullName, page, batchSize: issues.length, totalFetched }, 'Fetched issues page');
    
    if (issues.length > 0) {
      yield {
        issues,
        page,
        estimatedTotalPages,
        estimatedTotalIssues: estimatedTotalPages ? estimatedTotalPages * perPage : null,
      };
    }
    
    if (!response.data || response.data.length < perPage) break;
  }
}

// Streaming version with filtering for resume support
// sinceIssueNumber: when direction='asc', skip issues with number <= sinceIssueNumber
async function* streamIssuesWithFilter(options: {
  repoFullName: string;
  state: 'open' | 'all';
  since?: string | null;
  sort: 'updated' | 'created';
  direction: 'asc' | 'desc';
  perPage?: number;
  maxPages?: number;
  sinceIssueNumber: number | null;
}): AsyncGenerator<StreamBatch, void, unknown> {
  const { owner, repo } = parseRepoFullName(options.repoFullName);

  const perPage = options.perPage ?? 100;
  const maxPages = options.maxPages ?? getMaxPages();
  let totalFetched = 0;
  let estimatedTotalPages: number | null = null;
  const sinceIssueNumber = options.sinceIssueNumber;
  let skippedForResume = 0;

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams();
    params.set('state', options.state);
    params.set('per_page', String(perPage));
    params.set('page', String(page));
    params.set('sort', options.sort);
    params.set('direction', options.direction);
    if (options.since) params.set('since', options.since);

    logger.info({ repoFullName: options.repoFullName, page, estimatedTotalPages, issuesSoFar: totalFetched, skippedForResume }, 'Fetching issues page');
    const response = await githubRequestWithHeaders<GithubIssue[]>(`/repos/${owner}/${repo}/issues?${params.toString()}`);
    
    // Parse total pages from Link header on first request
    if (page === 1) {
      estimatedTotalPages = parseLastPageFromLink(response.linkHeader);
      if (estimatedTotalPages) {
        logger.info({ repoFullName: options.repoFullName, estimatedTotalPages, estimatedTotalIssues: estimatedTotalPages * perPage }, 'Estimated total from Link header');
      }
    }
    
    // Filter out PRs and skip already-processed issues for resume
    let issues = (response.data ?? []).filter((i) => !('pull_request' in i));
    
    if (sinceIssueNumber !== null && options.direction === 'asc') {
      const beforeFilter = issues.length;
      issues = issues.filter((i) => i.number > sinceIssueNumber);
      skippedForResume += beforeFilter - issues.length;
    }
    
    totalFetched += issues.length;
    
    logger.info({ repoFullName: options.repoFullName, page, batchSize: issues.length, totalFetched, skippedForResume }, 'Fetched issues page');
    
    if (issues.length > 0) {
      yield {
        issues,
        page,
        estimatedTotalPages,
        estimatedTotalIssues: estimatedTotalPages ? estimatedTotalPages * perPage : null,
      };
    }
    
    if (!response.data || response.data.length < perPage) break;
  }
}

export async function listIssuesUpdatedSince(options: {
  repoFullName: string;
  since: string | null;
  state: 'open' | 'all';
}): Promise<GithubIssue[]> {
  return listIssues({
    repoFullName: options.repoFullName,
    since: options.since,
    state: options.state,
    sort: 'updated',
    direction: 'asc',
  });
}

export async function listIssuesByCreated(options: {
  repoFullName: string;
  state: 'open' | 'all';
  direction: 'asc' | 'desc';
}): Promise<GithubIssue[]> {
  return listIssues({
    repoFullName: options.repoFullName,
    state: options.state,
    sort: 'created',
    direction: options.direction,
    maxPages: getMaxPages(),
  });
}

// Streaming version for full sync - yields batches with progress info
// sinceIssueNumber: skip issues with number <= this value (for resuming interrupted sync)
export function streamIssuesByCreated(options: {
  repoFullName: string;
  state: 'open' | 'all';
  direction: 'asc' | 'desc';
  sinceIssueNumber?: number | null;
}): AsyncGenerator<StreamBatch, void, unknown> {
  return streamIssuesWithFilter({
    repoFullName: options.repoFullName,
    state: options.state,
    sort: 'created',
    direction: options.direction,
    maxPages: getMaxPages(),
    sinceIssueNumber: options.sinceIssueNumber ?? null,
  });
}

export async function listIssuesNewerThanNumber(options: {
  repoFullName: string;
  state: 'open' | 'all';
  lastIssueNumber: number;
}): Promise<GithubIssue[]> {
  const { owner, repo } = parseRepoFullName(options.repoFullName);
  const collected: GithubIssue[] = [];
  const perPage = 100;
  const maxPages = getMaxPages();

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams();
    params.set('state', options.state);
    params.set('per_page', String(perPage));
    params.set('page', String(page));
    params.set('sort', 'created');
    params.set('direction', 'desc');

    const batch = await githubRequest<GithubIssue[]>(`/repos/${owner}/${repo}/issues?${params.toString()}`);
    if (!batch || batch.length === 0) break;

    let hitStop = false;
    for (const issue of batch) {
      if ('pull_request' in issue) continue;
      if (issue.number <= options.lastIssueNumber) {
        hitStop = true;
        break;
      }
      collected.push(issue);
    }

    if (hitStop || batch.length < perPage) break;
  }

  return collected;
}

export async function getLatestRelease(options: { repoFullName: string }): Promise<GithubRelease | null> {
  const { owner, repo } = parseRepoFullName(options.repoFullName);

  try {
    return await githubRequest<GithubRelease>(`/repos/${owner}/${repo}/releases/latest`);
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 404) {
      logger.warn({ repoFullName: options.repoFullName }, 'Latest release not found for repository');
      return null;
    }
    throw error;
  }
}
