type GithubUser = {
  login: string;
};

export type CompareCommit = {
  sha: string;
  commit: {
    message: string;
  };
  author: GithubUser | null;
};

type Pull = {
  number: number;
  user: GithubUser | null;
  merged_at?: string | null;
  draft?: boolean;
  state?: string;
};

export type PullRequestLabel = { name: string };

export type PullRequest = {
  number: number;
  title: string;
  body: string | null;
  user: GithubUser | null;
  additions: number;
  deletions: number;
  changed_files: number;
  merged_at: string | null;
  labels: PullRequestLabel[];
};

export type PullRequestFile = {
  filename: string;
  additions: number;
  deletions: number;
};

function requireGithubToken() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('Missing GITHUB_TOKEN');
  return token;
}

async function githubRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = requireGithubToken();
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API error ${res.status} ${res.statusText}: ${text}`);
  }

  return (await res.json()) as T;
}

export function parseRepoFullName(repoFullName: string) {
  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) throw new Error(`Invalid repoFullName: ${repoFullName}`);
  return { owner, repo };
}

export async function compareCommits(repoFullName: string, base: string, head: string): Promise<CompareCommit[]> {
  const { owner, repo } = parseRepoFullName(repoFullName);

  const encodedBase = encodeURIComponent(base);
  const encodedHead = encodeURIComponent(head);
  const data = await githubRequest<{ commits: CompareCommit[] }>(
    `/repos/${owner}/${repo}/compare/${encodedBase}...${encodedHead}`
  );

  // GitHub compare API returns (base, head] - excludes base, includes head
  return data.commits ?? [];
}

export async function listPullsForCommit(repoFullName: string, sha: string): Promise<Pull[]> {
  const { owner, repo } = parseRepoFullName(repoFullName);
  const encodedSha = encodeURIComponent(sha);
  return await githubRequest<Pull[]>(`/repos/${owner}/${repo}/commits/${encodedSha}/pulls`, {
    headers: {
      // This endpoint historically needed a preview accept; keep for compatibility.
      accept: 'application/vnd.github+json, application/vnd.github.groot-preview+json',
    },
  });
}

export async function getPullRequest(repoFullName: string, prNumber: number): Promise<PullRequest> {
  const { owner, repo } = parseRepoFullName(repoFullName);
  return await githubRequest<PullRequest>(`/repos/${owner}/${repo}/pulls/${prNumber}`);
}

export async function listPullRequestFiles(repoFullName: string, prNumber: number): Promise<PullRequestFile[]> {
  const { owner, repo } = parseRepoFullName(repoFullName);
  const files: PullRequestFile[] = [];

  const perPage = 100;
  for (let page = 1; page < 50; page++) {
    const batch = await githubRequest<PullRequestFile[]>(
      `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=${perPage}&page=${page}`
    );
    files.push(...(batch ?? []));
    if (!batch || batch.length < perPage) break;
  }

  return files;
}

export async function getCommit(repoFullName: string, sha: string): Promise<CompareCommit | null> {
  const { owner, repo } = parseRepoFullName(repoFullName);
  const encodedSha = encodeURIComponent(sha);
  try {
    return await githubRequest<CompareCommit>(`/repos/${owner}/${repo}/commits/${encodedSha}`);
  } catch {
    return null;
  }
}

/**
 * Get the diff for a specific commit.
 * Returns the raw diff content as a string.
 */
export async function getCommitDiff(repoFullName: string, sha: string): Promise<string> {
  const token = requireGithubToken();
  const { owner, repo } = parseRepoFullName(repoFullName);
  const encodedSha = encodeURIComponent(sha);
  
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${encodedSha}`, {
    headers: {
      accept: 'application/vnd.github.diff',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status} ${res.statusText}`);
  }

  return await res.text();
}
