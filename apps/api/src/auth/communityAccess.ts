import { createHash } from 'node:crypto';

type ViewerSource = 'community-md' | 'extra-allowlist' | 'access-control-disabled';

type AccessDecision =
  | {
      allowed: true;
      login?: string;
      source?: ViewerSource;
    }
  | {
      allowed: false;
      statusCode: number;
      message: string;
    };

type CachedDecision = {
  expiresAt: number;
  decision: AccessDecision;
};

type CommunityCache = {
  etag: string | null;
  expiresAt: number;
  members: Set<string>;
};

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const v = value.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return defaultValue;
}

function parsePositiveIntEnv(value: string | undefined, defaultValue: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

function parseCsvLowerSet(value: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const token of (value ?? '').split(',')) {
    const normalized = token.trim().toLowerCase();
    if (normalized) out.add(normalized);
  }
  return out;
}

function getPathWithoutQuery(url: string): string {
  const i = url.indexOf('?');
  return i >= 0 ? url.slice(0, i) : url;
}

function parseBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const m = headerValue.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  return token.length > 0 ? token : null;
}

function parseCommunityMembersFromMarkdown(md: string): Set<string> {
  const members = new Set<string>();

  // Preferred pattern in PowerToys COMMUNITY.md:
  // [@login](https://github.com/login)
  const explicitMentionPattern = /\[@([A-Za-z0-9-]+)\]\(https:\/\/github\.com\/([A-Za-z0-9-]+)\/?\)/gim;
  for (const match of md.matchAll(explicitMentionPattern)) {
    const login = (match[2] ?? match[1] ?? '').trim().toLowerCase();
    if (login) members.add(login);
  }

  // Defensive fallback: any GitHub profile links.
  if (members.size === 0) {
    const githubProfilePattern = /https:\/\/github\.com\/([A-Za-z0-9-]+)\/?/gim;
    for (const match of md.matchAll(githubProfilePattern)) {
      const login = (match[1] ?? '').trim().toLowerCase();
      if (login) members.add(login);
    }
  }

  return members;
}

async function fetchGithubLoginFromToken(token: string): Promise<string | null> {
  const res: any = await fetch('https://api.github.com/user', {
    method: 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'release-agent-api',
    },
  });

  if (res.status === 401 || res.status === 403) {
    return null;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub /user failed with ${res.status}: ${text}`);
  }

  const body = (await res.json()) as any;
  const login = typeof body?.login === 'string' ? body.login.trim() : '';
  return login || null;
}

export function createCommunityAccessController() {
  const enabled = parseBooleanEnv(process.env.ACCESS_CONTROL_ENABLED, true);
  const communityDocUrl =
    process.env.ACCESS_CONTROL_COMMUNITY_DOC_URL?.trim() ||
    'https://raw.githubusercontent.com/microsoft/PowerToys/main/COMMUNITY.md';
  const communityCacheTtlSeconds = parsePositiveIntEnv(
    process.env.ACCESS_CONTROL_COMMUNITY_CACHE_SECONDS,
    600
  );
  const tokenCacheTtlSeconds = parsePositiveIntEnv(
    process.env.ACCESS_CONTROL_TOKEN_CACHE_SECONDS,
    300
  );
  const extraAllowlist = parseCsvLowerSet(process.env.ACCESS_CONTROL_EXTRA_LOGINS);

  const tokenDecisionCache = new Map<string, CachedDecision>();
  let communityCache: CommunityCache | null = null;

  function tokenCacheKey(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  function isPublicRequest(method: string, url: string): boolean {
    if (method.toUpperCase() === 'OPTIONS') return true;
    const path = getPathWithoutQuery(url);
    return (
      path === '/healthz' ||
      path === '/docs' ||
      path === '/openapi.yaml' ||
      path.startsWith('/docs/')
    );
  }

  async function getCommunityMembers(): Promise<Set<string>> {
    const now = Date.now();
    if (communityCache && communityCache.expiresAt > now) {
      return communityCache.members;
    }

    try {
      const res: any = await fetch(communityDocUrl, {
        method: 'GET',
        headers: {
          ...(communityCache?.etag ? { 'if-none-match': communityCache.etag } : {}),
          'user-agent': 'release-agent-api',
        },
      });

      if (res.status === 304 && communityCache) {
        communityCache = {
          ...communityCache,
          expiresAt: now + communityCacheTtlSeconds * 1000,
        };
        return communityCache.members;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Community doc fetch failed with ${res.status}: ${text}`);
      }

      const text = (await res.text()) as string;
      const members = parseCommunityMembersFromMarkdown(text);
      if (members.size === 0) {
        throw new Error('No community members parsed from COMMUNITY.md');
      }

      communityCache = {
        etag: (res.headers?.get?.('etag') as string | null | undefined) ?? null,
        expiresAt: now + communityCacheTtlSeconds * 1000,
        members,
      };
      return members;
    } catch (err) {
      if (communityCache) {
        // Fallback to stale cache when refresh fails.
        return communityCache.members;
      }
      throw err;
    }
  }

  async function authorize(input: {
    method: string;
    url: string;
    authorizationHeader: string | undefined;
  }): Promise<AccessDecision> {
    if (!enabled) {
      return { allowed: true, login: 'access-disabled', source: 'access-control-disabled' };
    }

    if (isPublicRequest(input.method, input.url)) {
      return { allowed: true };
    }

    const token = parseBearerToken(input.authorizationHeader);
    if (!token) {
      return {
        allowed: false,
        statusCode: 401,
        message: 'Missing Authorization bearer token',
      };
    }

    const now = Date.now();
    const key = tokenCacheKey(token);
    const cached = tokenDecisionCache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.decision;
    }

    const login = await fetchGithubLoginFromToken(token);
    if (!login) {
      const denied: AccessDecision = {
        allowed: false,
        statusCode: 401,
        message: 'Invalid GitHub token',
      };
      tokenDecisionCache.set(key, {
        expiresAt: now + tokenCacheTtlSeconds * 1000,
        decision: denied,
      });
      return denied;
    }

    const normalizedLogin = login.toLowerCase();

    if (extraAllowlist.has(normalizedLogin)) {
      const allowed: AccessDecision = {
        allowed: true,
        login,
        source: 'extra-allowlist',
      };
      tokenDecisionCache.set(key, {
        expiresAt: now + tokenCacheTtlSeconds * 1000,
        decision: allowed,
      });
      return allowed;
    }

    let members: Set<string>;
    try {
      members = await getCommunityMembers();
    } catch {
      return {
        allowed: false,
        statusCode: 503,
        message: 'Unable to load community member list for authorization',
      };
    }

    if (!members.has(normalizedLogin)) {
      const denied: AccessDecision = {
        allowed: false,
        statusCode: 403,
        message: `GitHub user @${login} is not in PowerToys COMMUNITY.md`,
      };
      tokenDecisionCache.set(key, {
        expiresAt: now + tokenCacheTtlSeconds * 1000,
        decision: denied,
      });
      return denied;
    }

    const allowed: AccessDecision = {
      allowed: true,
      login,
      source: 'community-md',
    };
    tokenDecisionCache.set(key, {
      expiresAt: now + tokenCacheTtlSeconds * 1000,
      decision: allowed,
    });
    return allowed;
  }

  return {
    enabled,
    authorize,
  };
}
