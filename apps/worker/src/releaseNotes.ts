import type { CompareCommit } from './github.js';
import type { ReleaseNoteItem, ReleaseNotesArtifact } from '@release-agent/contracts';

/**
 * PowerToys team members - no need to credit them in release notes
 */
const TEAM_MEMBERS = new Set([
  'craigloewen-msft',  // Craig Loewen - Product Manager
  'niels9001',         // Niels Laute - Product Manager
  'dhowett',           // Dustin Howett - Dev Lead
  'yeelam-gordon',     // Gordon Lam - Dev Lead
  'jamrobot',          // Jerry Xu - Dev Lead
  'lei9444',           // Leilei Zhang - Dev
  'shuaiyuanxx',       // Shawn Yuan - Dev
  'moooyo',            // Yu Leng - Dev
  'haoliuu',           // Hao Liu - Dev
  'chenmy77',          // Mengyuan Chen - Dev
  'chemwolf6922',      // Feng Wang - Dev
  'yaqingmi',          // Yaqing Mi - Dev
  'zhaoqpcn',          // Qingpeng Zhao - Dev
  'urnotdfs',          // Xiaofeng Wang - Dev
  'zhaopy536',         // Peiyao Zhao - Dev
  'wang563681252',     // Zhaopeng Wang - Dev
  'vanzue',            // Kai Tao - Dev
  'zadjii-msft',       // Mike Griese - Dev
  'khmyznikov',        // Gleb Khmyznikov - Dev
  'chatasweetie',      // Jessica Earley-Cha - Dev
  'MichaelJolley',     // Michael Jolley - Dev
  'Jaylyn-Barbee',     // Jaylyn Barbee - Dev
  'zateutsch',         // Zach Teutsch - Dev
  'crutkas',           // Clint Rutkas - Overhead
]);

/**
 * Check if a GitHub login is a PowerToys team member
 */
function isTeamMember(login?: string | null): boolean {
  if (!login) return false;
  return TEAM_MEMBERS.has(login) || TEAM_MEMBERS.has(login.toLowerCase());
}

function normalizeSubject(message: string) {
  const subject = (message ?? '').split('\n')[0]?.trim() ?? '';
  if (!subject) return '';

  // Drop common conventional-commit prefixes.
  const stripped = subject.replace(/^(feat|fix|chore|docs|refactor|test|build|ci|perf|style)(\\(.+\\))?:\\s*/i, '');

  // Drop trailing PR reference like "(#12345)".
  const noPr = stripped.replace(/\\s*\\(#\\d+\\)\\s*$/g, '');

  const capped = noPr.length > 0 ? noPr[0].toUpperCase() + noPr.slice(1) : noPr;
  return capped.endsWith('.') || capped.endsWith('!') || capped.endsWith('?') ? capped : `${capped}.`;
}

function thanks(login?: string | null) {
  if (!login) return '';
  // Don't credit team members - they are internal contributors
  if (isTeamMember(login)) return '';
  return ` Thanks [@${login}](https://github.com/${login})!`;
}

export function commitToReleaseNoteText(subject: string, creditedLogin?: string | null) {
  const normalized = normalizeSubject(subject);
  if (!normalized) return '';
  return `${normalized}${thanks(creditedLogin)}`;
}

/**
 * Format a release note summary with optional thanks and PR link.
 * Used for LLM-generated summaries that need formatting.
 */
export function formatReleaseNote(
  summary: string,
  options?: {
    creditedLogin?: string | null;
    prNumber?: number | null;
    repoFullName?: string;
  }
): string {
  // Ensure summary ends with period
  let text = summary.trim();
  if (text && !text.endsWith('.') && !text.endsWith('!') && !text.endsWith('?')) {
    text = `${text}.`;
  }
  
  // Add PR link if available
  if (options?.prNumber && options?.repoFullName) {
    text = `${text} ([#${options.prNumber}](https://github.com/${options.repoFullName}/pull/${options.prNumber}))`;
  }
  
  // Add thanks if author is not a team member
  if (options?.creditedLogin && !isTeamMember(options.creditedLogin)) {
    text = `${text} Thanks [@${options.creditedLogin}](https://github.com/${options.creditedLogin})!`;
  }
  
  return text;
}

export function buildReleaseNotesArtifact(
  sessionId: string,
  commits: Array<CompareCommit & { creditedLogin?: string | null }>
): ReleaseNotesArtifact {
  const items = commits
    .map((c): ReleaseNoteItem | null => {
      const text = commitToReleaseNoteText(c.commit.message, c.creditedLogin ?? c.author?.login ?? null);
      if (!text) return null;
      const item: ReleaseNoteItem = {
        id: c.sha,
        text,
        source: { kind: 'commit', ref: c.sha },
        excluded: false,
      };
      return item;
    })
    .filter((x): x is ReleaseNoteItem => x !== null);

  return {
    sessionId,
    sections: [{ area: 'General', items }],
  };
}
