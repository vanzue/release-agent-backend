import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type ViewerSource = 'community-md' | 'extra-allowlist' | 'access-control-disabled';

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

type TokenPayload = {
  typ: 'oauth-state' | 'session';
  iat: number;
  exp: number;
  login?: string;
  source?: ViewerSource;
  returnTo?: string;
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

  const explicitMentionPattern = /\[@([A-Za-z0-9-]+)\]\(https:\/\/github\.com\/([A-Za-z0-9-]+)\/?\)/gim;
  for (const match of md.matchAll(explicitMentionPattern)) {
    const login = (match[2] ?? match[1] ?? '').trim().toLowerCase();
    if (login) members.add(login);
  }

  if (members.size === 0) {
    const githubProfilePattern = /https:\/\/github\.com\/([A-Za-z0-9-]+)\/?/gim;
    for (const match of md.matchAll(githubProfilePattern)) {
      const login = (match[1] ?? '').trim().toLowerCase();
      if (login) members.add(login);
    }
  }

  return members;
}

function base64UrlEncode(input: Buffer | string): string {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecodeToBuffer(input: string): Buffer | null {
  if (!input) return null;
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  try {
    return Buffer.from(normalized + padding, 'base64');
  } catch {
    return null;
  }
}

function base64UrlDecodeToString(input: string): string | null {
  const buffer = base64UrlDecodeToBuffer(input);
  return buffer ? buffer.toString('utf-8') : null;
}

function buildSignedToken(payload: TokenPayload, secret: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac('sha256', secret).update(data).digest();
  return `${data}.${base64UrlEncode(signature)}`;
}

function verifySignedToken(token: string, secret: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, encodedSig] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSig) return null;

  const data = `${encodedHeader}.${encodedPayload}`;
  const expectedSig = createHmac('sha256', secret).update(data).digest();
  const providedSig = base64UrlDecodeToBuffer(encodedSig);
  if (!providedSig) return null;
  if (providedSig.length !== expectedSig.length) return null;
  if (!timingSafeEqual(providedSig, expectedSig)) return null;

  const payloadText = base64UrlDecodeToString(encodedPayload);
  if (!payloadText) return null;

  let payload: any;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return null;
  }

  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.typ !== 'string') return null;
  if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') return null;

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) return null;

  return payload as TokenPayload;
}

function normalizeReturnToPath(value: string | undefined): string {
  const raw = (value ?? '').trim();
  if (!raw) return '/';
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//')) return '/';
  return raw;
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
  const patCacheTtlSeconds = parsePositiveIntEnv(process.env.ACCESS_CONTROL_TOKEN_CACHE_SECONDS, 300);
  const sessionTokenTtlSeconds = parsePositiveIntEnv(process.env.AUTH_SESSION_TTL_SECONDS, 43200);
  const oauthStateTtlSeconds = parsePositiveIntEnv(process.env.AUTH_OAUTH_STATE_TTL_SECONDS, 600);

  const extraAllowlist = parseCsvLowerSet(process.env.ACCESS_CONTROL_EXTRA_LOGINS);
  const oauthClientId = process.env.GITHUB_OAUTH_CLIENT_ID?.trim() ?? '';
  const oauthClientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET?.trim() ?? '';
  const oauthCallbackUrlConfigured = process.env.GITHUB_OAUTH_CALLBACK_URL?.trim() ?? '';
  const frontendBaseUrlConfigured =
    process.env.AUTH_FRONTEND_BASE_URL?.trim() ||
    process.env.CORS_ORIGIN?.split(',')[0]?.trim() ||
    '';
  const appTokenSecret = process.env.AUTH_APP_TOKEN_SECRET?.trim() ?? '';

  const patDecisionCache = new Map<string, CachedDecision>();
  let communityCache: CommunityCache | null = null;

  function getFrontendBaseUrlOrThrow(): string {
    if (!frontendBaseUrlConfigured) {
      throw new Error('Missing AUTH_FRONTEND_BASE_URL');
    }
    return frontendBaseUrlConfigured;
  }

  function getOAuthCallbackUrl(apiOrigin: string): string {
    return oauthCallbackUrlConfigured || `${apiOrigin}/auth/github/callback`;
  }

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
      path.startsWith('/docs/') ||
      path === '/auth/github/start' ||
      path === '/auth/github/callback'
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
    } catch {
      if (communityCache) {
        return communityCache.members;
      }
      throw new Error('Unable to load community member list for authorization');
    }
  }

  async function classifyGithubLogin(login: string): Promise<{ source: ViewerSource } | { error: string; statusCode: number }> {
    const normalizedLogin = login.toLowerCase();

    if (extraAllowlist.has(normalizedLogin)) {
      return { source: 'extra-allowlist' };
    }

    let members: Set<string>;
    try {
      members = await getCommunityMembers();
    } catch (err: any) {
      return { error: err?.message ?? 'Unable to load community member list for authorization', statusCode: 503 };
    }

    if (!members.has(normalizedLogin)) {
      return {
        error: `GitHub user @${login} is not in PowerToys COMMUNITY.md`,
        statusCode: 403,
      };
    }

    return { source: 'community-md' };
  }

  function createSessionToken(login: string, source: ViewerSource): string {
    if (!appTokenSecret) {
      throw new Error('Missing AUTH_APP_TOKEN_SECRET');
    }
    const now = Math.floor(Date.now() / 1000);
    return buildSignedToken(
      {
        typ: 'session',
        iat: now,
        exp: now + sessionTokenTtlSeconds,
        login,
        source,
      },
      appTokenSecret
    );
  }

  function verifySessionToken(token: string): { login: string; source: ViewerSource } | null {
    if (!appTokenSecret) return null;
    const payload = verifySignedToken(token, appTokenSecret);
    if (!payload) return null;
    if (payload.typ !== 'session') return null;
    if (!payload.login || !payload.source) return null;
    if (typeof payload.login !== 'string' || typeof payload.source !== 'string') return null;
    const source = payload.source as ViewerSource;
    if (source !== 'community-md' && source !== 'extra-allowlist') return null;
    return { login: payload.login, source };
  }

  function createOAuthStateToken(returnToPath: string): string {
    if (!appTokenSecret) {
      throw new Error('Missing AUTH_APP_TOKEN_SECRET');
    }
    const now = Math.floor(Date.now() / 1000);
    return buildSignedToken(
      {
        typ: 'oauth-state',
        iat: now,
        exp: now + oauthStateTtlSeconds,
        returnTo: normalizeReturnToPath(returnToPath),
      },
      appTokenSecret
    );
  }

  function verifyOAuthStateToken(token: string): { returnToPath: string } | null {
    if (!appTokenSecret) return null;
    const payload = verifySignedToken(token, appTokenSecret);
    if (!payload || payload.typ !== 'oauth-state') return null;
    return { returnToPath: normalizeReturnToPath(payload.returnTo) };
  }

  function buildFrontendRedirect(input: {
    returnToPath?: string;
    sessionToken?: string;
    error?: string;
  }): string {
    const baseUrl = getFrontendBaseUrlOrThrow();
    const targetUrl = new URL(normalizeReturnToPath(input.returnToPath), baseUrl);
    const hash = new URLSearchParams();
    if (input.sessionToken) hash.set('ra_token', input.sessionToken);
    if (input.error) hash.set('ra_error', input.error);
    if (hash.toString()) {
      targetUrl.hash = hash.toString();
    }
    return targetUrl.toString();
  }

  function beginGithubOAuth(input: { apiOrigin: string; returnToPath?: string }): { redirectUrl: string } {
    if (!enabled) {
      throw new Error('Access control is disabled');
    }
    if (!oauthClientId) {
      throw new Error('Missing GITHUB_OAUTH_CLIENT_ID');
    }
    if (!appTokenSecret) {
      throw new Error('Missing AUTH_APP_TOKEN_SECRET');
    }

    const callbackUrl = getOAuthCallbackUrl(input.apiOrigin);
    const returnToPath = normalizeReturnToPath(input.returnToPath);
    const state = createOAuthStateToken(returnToPath);

    const authUrl = new URL('https://github.com/login/oauth/authorize');
    authUrl.searchParams.set('client_id', oauthClientId);
    authUrl.searchParams.set('redirect_uri', callbackUrl);
    authUrl.searchParams.set('scope', 'read:user');
    authUrl.searchParams.set('state', state);

    return { redirectUrl: authUrl.toString() };
  }

  async function completeGithubOAuth(input: {
    apiOrigin: string;
    code: string;
    state: string;
  }): Promise<{ login: string; source: ViewerSource; sessionToken: string; returnToPath: string }> {
    if (!enabled) {
      throw new Error('Access control is disabled');
    }
    if (!oauthClientId) throw new Error('Missing GITHUB_OAUTH_CLIENT_ID');
    if (!oauthClientSecret) throw new Error('Missing GITHUB_OAUTH_CLIENT_SECRET');
    if (!appTokenSecret) throw new Error('Missing AUTH_APP_TOKEN_SECRET');

    const statePayload = verifyOAuthStateToken(input.state);
    if (!statePayload) {
      throw new Error('Invalid or expired OAuth state');
    }

    const callbackUrl = getOAuthCallbackUrl(input.apiOrigin);
    const tokenRes: any = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'release-agent-api',
      },
      body: JSON.stringify({
        client_id: oauthClientId,
        client_secret: oauthClientSecret,
        code: input.code,
        redirect_uri: callbackUrl,
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text().catch(() => '');
      throw new Error(`GitHub OAuth token exchange failed (${tokenRes.status}): ${text}`);
    }

    const tokenBody = (await tokenRes.json()) as any;
    const githubAccessToken =
      typeof tokenBody?.access_token === 'string' ? tokenBody.access_token.trim() : '';
    if (!githubAccessToken) {
      throw new Error('GitHub OAuth token exchange did not return access_token');
    }

    const login = await fetchGithubLoginFromToken(githubAccessToken);
    if (!login) {
      throw new Error('Unable to resolve GitHub user from OAuth token');
    }

    const classResult = await classifyGithubLogin(login);
    if ('error' in classResult) {
      throw new Error(classResult.error);
    }

    const sessionToken = createSessionToken(login, classResult.source);
    return {
      login,
      source: classResult.source,
      sessionToken,
      returnToPath: statePayload.returnToPath,
    };
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

    const sessionViewer = verifySessionToken(token);
    if (sessionViewer) {
      return {
        allowed: true,
        login: sessionViewer.login,
        source: sessionViewer.source,
      };
    }

    const now = Date.now();
    const cacheKey = tokenCacheKey(token);
    const cached = patDecisionCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.decision;
    }

    const login = await fetchGithubLoginFromToken(token);
    if (!login) {
      const denied: AccessDecision = {
        allowed: false,
        statusCode: 401,
        message: 'Invalid bearer token',
      };
      patDecisionCache.set(cacheKey, {
        expiresAt: now + patCacheTtlSeconds * 1000,
        decision: denied,
      });
      return denied;
    }

    const classResult = await classifyGithubLogin(login);
    if ('error' in classResult) {
      const denied: AccessDecision = {
        allowed: false,
        statusCode: classResult.statusCode,
        message: classResult.error,
      };
      patDecisionCache.set(cacheKey, {
        expiresAt: now + patCacheTtlSeconds * 1000,
        decision: denied,
      });
      return denied;
    }

    const allowed: AccessDecision = {
      allowed: true,
      login,
      source: classResult.source,
    };
    patDecisionCache.set(cacheKey, {
      expiresAt: now + patCacheTtlSeconds * 1000,
      decision: allowed,
    });
    return allowed;
  }

  return {
    enabled,
    authorize,
    beginGithubOAuth,
    completeGithubOAuth,
    buildFrontendRedirect,
  };
}

export type CommunityAccessController = ReturnType<typeof createCommunityAccessController>;
