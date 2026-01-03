export type GithubLabel = {
  name: string;
};

export type GithubMilestone = {
  title: string;
};

export type GithubReactions = {
  total_count: number;
};

export type GithubIssue = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  labels: GithubLabel[];
  milestone: GithubMilestone | null;
  comments: number;
  reactions?: GithubReactions;
  pull_request?: unknown; // present when the item is a PR
};

export type { IssueSyncRequest, IssueReclusterRequest } from '@release-agent/contracts';
