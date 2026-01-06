import pino from 'pino';

const logger = pino({
  name: 'retry',
  level: process.env.LOG_LEVEL ?? 'info',
});

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retry configuration for API calls.
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (total calls = maxAttempts) */
  maxAttempts: number;
  /** Initial delay in milliseconds before first retry */
  initialDelayMs: number;
  /** Maximum delay in milliseconds (caps exponential backoff) */
  maxDelayMs: number;
  /** Multiplier for exponential backoff (e.g., 2 = double each time) */
  backoffMultiplier: number;
  /** Add random jitter to delays to avoid thundering herd */
  jitter?: boolean;
}

/**
 * Information about why a retry is happening.
 */
export interface RetryContext {
  /** Human-readable name for the operation */
  operation: string;
  /** Current attempt number (1-based) */
  attempt: number;
  /** Maximum attempts */
  maxAttempts: number;
  /** Delay before next retry in ms */
  delayMs: number;
  /** The error that triggered the retry */
  error: Error;
}

/**
 * Function to determine if an error should trigger a retry.
 */
export type ShouldRetryFn = (error: unknown) => boolean;

/**
 * Function to extract retry-after delay from an error (in milliseconds).
 */
export type GetRetryDelayFn = (error: unknown) => number | null;

// ─────────────────────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 5,
  initialDelayMs: 5000, // 5 seconds
  maxDelayMs: 120000, // 2 minutes
  backoffMultiplier: 2,
  jitter: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff and optional jitter.
 */
export function calculateBackoff(
  attempt: number,
  config: RetryConfig,
  retryAfterMs?: number | null
): number {
  // Use retry-after if provided, otherwise calculate exponential backoff
  const baseDelay = retryAfterMs ?? config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);
  const cappedDelay = Math.min(baseDelay, config.maxDelayMs);
  
  // Add jitter (0-1000ms) to avoid thundering herd
  const jitter = config.jitter ? Math.random() * 1000 : 0;
  
  return cappedDelay + jitter;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Error Checkers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default function to check if an error is retryable.
 * Handles rate limits (429), server errors (5xx), timeouts, and network errors.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    const name = error.name.toLowerCase();

    // Rate limit errors (429)
    if (message.includes('rate limit') || message.includes('429') || message.includes('too many requests')) {
      return true;
    }

    // Server errors (5xx)
    if (message.includes('500') || message.includes('502') || message.includes('503') || message.includes('504')) {
      return true;
    }

    // Timeout errors
    if (message.includes('timeout') || message.includes('timed out') || name.includes('timeout')) {
      return true;
    }

    // Network errors
    if (message.includes('econnreset') || message.includes('econnrefused') || message.includes('network')) {
      return true;
    }

    // Check for status property on error object (some SDKs add this)
    const errorWithStatus = error as Error & { status?: number; statusCode?: number };
    const status = errorWithStatus.status ?? errorWithStatus.statusCode;
    if (status === 429 || (status && status >= 500 && status < 600)) {
      return true;
    }
  }

  return false;
}

/**
 * Default function to extract retry-after delay from error.
 * Checks for retry-after header in error object.
 */
export function getRetryDelayFromError(error: unknown): number | null {
  if (error instanceof Error) {
    const errorWithHeaders = error as Error & { headers?: Record<string, string> };
    const retryAfter = errorWithHeaders.headers?.['retry-after'];
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds)) {
        return seconds * 1000;
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Retry Function
// ─────────────────────────────────────────────────────────────────────────────

export interface WithRetryOptions {
  /** Retry configuration */
  config?: Partial<RetryConfig>;
  /** Human-readable name for the operation (for logging) */
  operation?: string;
  /** Custom function to determine if error should trigger retry */
  shouldRetry?: ShouldRetryFn;
  /** Custom function to extract retry delay from error */
  getRetryDelay?: GetRetryDelayFn;
  /** Callback when a retry is about to happen */
  onRetry?: (context: RetryContext) => void;
}

/**
 * Execute a function with retry logic for transient failures.
 * 
 * @example
 * ```ts
 * // Basic usage
 * const result = await withRetry(
 *   () => fetchData(),
 *   { operation: 'fetch-data' }
 * );
 * 
 * // Custom retry logic
 * const result = await withRetry(
 *   () => callGitHubApi(),
 *   {
 *     operation: 'github-api',
 *     config: { maxAttempts: 6, initialDelayMs: 5000 },
 *     shouldRetry: (err) => isRateLimitError(err),
 *   }
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: WithRetryOptions = {}
): Promise<T> {
  const config: RetryConfig = {
    ...DEFAULT_RETRY_CONFIG,
    ...options.config,
  };
  const operation = options.operation ?? 'unknown';
  const shouldRetry = options.shouldRetry ?? isRetryableError;
  const getRetryDelay = options.getRetryDelay ?? getRetryDelayFromError;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry if it's not a retryable error or we've exhausted attempts
      if (!shouldRetry(error) || attempt === config.maxAttempts) {
        logger.error(
          { err: lastError, attempt, maxAttempts: config.maxAttempts, operation },
          'Operation failed (not retrying)'
        );
        throw lastError;
      }

      // Calculate delay with exponential backoff
      const retryAfterMs = getRetryDelay(error);
      const delayMs = calculateBackoff(attempt, config, retryAfterMs);

      const context: RetryContext = {
        operation,
        attempt,
        maxAttempts: config.maxAttempts,
        delayMs,
        error: lastError,
      };

      // Call onRetry callback if provided
      options.onRetry?.(context);

      logger.warn(
        { 
          err: lastError, 
          attempt, 
          maxAttempts: config.maxAttempts, 
          delayMs: Math.round(delayMs), 
          operation 
        },
        'Operation failed, retrying...'
      );

      await sleep(delayMs);
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError ?? new Error(`${operation} failed after retries`);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-specific Helpers (for fetch-based APIs)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if an HTTP status code indicates a rate limit or retryable error.
 */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Check if an HTTP response is a rate limit error (for GitHub specifically).
 */
export function isHttpRateLimitError(status: number, responseText: string): boolean {
  if (status === 429) return true;
  if (status === 403 && responseText.toLowerCase().includes('rate limit')) return true;
  return false;
}

/**
 * Extract retry delay from HTTP response headers.
 */
export function getRetryDelayFromHeaders(headers: Headers, maxDelayMs: number = 120000): number | null {
  // Check Retry-After header (in seconds)
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) return Math.min(seconds * 1000, maxDelayMs);
  }

  // Check x-ratelimit-reset header (Unix timestamp, used by GitHub)
  const resetAt = headers.get('x-ratelimit-reset');
  if (resetAt) {
    const resetTime = parseInt(resetAt, 10) * 1000;
    const now = Date.now();
    if (resetTime > now) return Math.min(resetTime - now, maxDelayMs);
  }

  return null;
}

/**
 * Wrapper for fetch with built-in retry for transient failures.
 * 
 * @example
 * ```ts
 * const response = await fetchWithRetry('https://api.example.com/data', {
 *   headers: { 'Authorization': 'Bearer token' }
 * }, {
 *   operation: 'fetch-data',
 *   isRetryable: (status, text) => status === 429,
 * });
 * ```
 */
export interface FetchWithRetryOptions extends WithRetryOptions {
  /** Custom function to check if response should trigger retry */
  isRetryable?: (status: number, responseText: string) => boolean;
}

export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  options: FetchWithRetryOptions = {}
): Promise<Response> {
  const isRetryable = options.isRetryable ?? isHttpRateLimitError;
  const config: RetryConfig = {
    ...DEFAULT_RETRY_CONFIG,
    ...options.config,
  };
  const operation = options.operation ?? url;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    const response = await fetch(url, init);

    if (response.ok) {
      return response;
    }

    const responseText = await response.text().catch(() => '');

    // Check if this is a retryable error
    if (isRetryable(response.status, responseText)) {
      if (attempt < config.maxAttempts) {
        const retryAfterMs = getRetryDelayFromHeaders(response.headers, config.maxDelayMs);
        const delayMs = calculateBackoff(attempt, config, retryAfterMs);

        logger.warn(
          {
            url,
            status: response.status,
            attempt,
            maxAttempts: config.maxAttempts,
            delayMs: Math.round(delayMs),
            operation,
          },
          'HTTP request rate limited, retrying...'
        );

        await sleep(delayMs);
        continue;
      }
      lastError = new Error(`Rate limit exceeded after ${config.maxAttempts} attempts: ${responseText}`);
    } else {
      // Non-retryable error, throw immediately
      throw new Error(`HTTP error ${response.status} ${response.statusText}: ${responseText}`);
    }
  }

  throw lastError ?? new Error(`${operation} failed after retries`);
}
