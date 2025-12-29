import pino from 'pino';
import { generateText, generateObject, LanguageModel } from 'ai';
import { createAzure } from '@ai-sdk/azure';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';

const logger = pino({
  name: 'llm',
  level: process.env.LOG_LEVEL ?? 'info',
});

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionOptions {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface LLMClient {
  chat(options: ChatCompletionOptions): Promise<string>;
  generateObject<T>(options: {
    schema: z.ZodSchema<T>;
    messages: ChatMessage[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<T>;
  getModel(): LanguageModel;
}

export type LLMProvider = 'azure' | 'openai' | 'anthropic' | 'google';

/**
 * Retry configuration for LLM calls.
 */
interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

/**
 * Check if an error is retryable (rate limits, server errors).
 */
function isRetryableError(error: unknown): boolean {
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
 * Extract retry-after delay from error if present.
 */
function getRetryAfterMs(error: unknown): number | null {
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

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry logic for transient failures.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  context?: string
): Promise<T> {
  let lastError: Error | undefined;
  let delay = config.initialDelayMs;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Don't retry if it's not a retryable error or we've exhausted attempts
      if (!isRetryableError(error) || attempt === config.maxAttempts) {
        logger.error(
          { err: lastError, attempt, maxAttempts: config.maxAttempts, context },
          'LLM call failed (not retrying)'
        );
        throw lastError;
      }

      // Check for retry-after header
      const retryAfterMs = getRetryAfterMs(error);
      const actualDelay = retryAfterMs ? Math.min(retryAfterMs, config.maxDelayMs) : delay;

      logger.warn(
        { err: lastError, attempt, maxAttempts: config.maxAttempts, delayMs: actualDelay, context },
        'LLM call failed, retrying...'
      );

      await sleep(actualDelay);
      
      // Exponential backoff for next attempt
      delay = Math.min(delay * config.backoffMultiplier, config.maxDelayMs);
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError ?? new Error('Retry failed');
}

/**
 * Create the appropriate model based on LLM_PROVIDER env var.
 * 
 * Environment variables by provider:
 * 
 * azure:
 *   - AZURE_OPENAI_ENDPOINT: e.g., https://your-resource.openai.azure.com
 *   - AZURE_OPENAI_API_KEY: your API key
 *   - LLM_MODEL: deployment name (e.g., gpt-4o-mini)
 *   - AZURE_OPENAI_API_VERSION: (optional) API version for legacy API
 *     - If NOT set: uses new v1 API (recommended, no api-version needed)
 *     - If set: uses legacy API with specified version (e.g., 2024-08-01-preview)
 * 
 * openai:
 *   - OPENAI_API_KEY: your API key
 *   - LLM_MODEL: model ID (e.g., gpt-4o-mini)
 * 
 * anthropic:
 *   - ANTHROPIC_API_KEY: your API key
 *   - LLM_MODEL: model ID (e.g., claude-sonnet-4-20250514)
 * 
 * google:
 *   - GOOGLE_GENERATIVE_AI_API_KEY: your API key
 *   - LLM_MODEL: model ID (e.g., gemini-1.5-flash)
 */
function createModel(): LanguageModel | null {
  const provider = (process.env.LLM_PROVIDER ?? 'azure') as LLMProvider;
  const modelId = process.env.LLM_MODEL;

  if (!modelId) {
    logger.warn('LLM_MODEL not configured');
    return null;
  }

  switch (provider) {
    case 'azure': {
      const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
      const apiKey = process.env.AZURE_OPENAI_API_KEY;
      const apiVersion = process.env.AZURE_OPENAI_API_VERSION;

      if (!endpoint || !apiKey) {
        logger.warn('Azure OpenAI not configured (missing AZURE_OPENAI_ENDPOINT or AZURE_OPENAI_API_KEY)');
        return null;
      }

      // If no apiVersion is specified, use the new v1 API (recommended)
      // Otherwise, use the legacy API with the specified version
      if (!apiVersion) {
        // Use the new v1 API - construct base URL with /openai/v1/
        const baseURL = endpoint.replace(/\/?$/, '/openai/v1/');
        const openai = createOpenAI({
          apiKey,
          baseURL,
        });
        logger.info({ provider, endpoint, modelId, apiStyle: 'v1' }, 'LLM client initialized (Azure v1 API)');
        return openai.chat(modelId);
      } else {
        // Use legacy Azure API with api-version
        const azure = createAzure({
          resourceName: extractResourceName(endpoint),
          apiKey,
          apiVersion,
        });
        logger.info({ provider, endpoint, modelId, apiVersion, apiStyle: 'legacy' }, 'LLM client initialized (Azure legacy API)');
        return azure.chat(modelId);
      }
    }

    case 'openai': {
      const apiKey = process.env.OPENAI_API_KEY;

      if (!apiKey) {
        logger.warn('OpenAI not configured (missing OPENAI_API_KEY)');
        return null;
      }

      const openai = createOpenAI({ apiKey });
      logger.info({ provider, modelId }, 'LLM client initialized (OpenAI)');
      // Use .chat() to force Chat Completions API instead of Responses API
      return openai.chat(modelId);
    }

    case 'anthropic': {
      const apiKey = process.env.ANTHROPIC_API_KEY;

      if (!apiKey) {
        logger.warn('Anthropic not configured (missing ANTHROPIC_API_KEY)');
        return null;
      }

      const anthropic = createAnthropic({ apiKey });
      logger.info({ provider, modelId }, 'LLM client initialized (Anthropic)');
      return anthropic(modelId);
    }

    case 'google': {
      const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

      if (!apiKey) {
        logger.warn('Google not configured (missing GOOGLE_GENERATIVE_AI_API_KEY)');
        return null;
      }

      const google = createGoogleGenerativeAI({ apiKey });
      logger.info({ provider, modelId }, 'LLM client initialized (Google)');
      return google(modelId);
    }

    default:
      logger.warn({ provider }, 'Unknown LLM provider');
      return null;
  }
}

/**
 * Create an LLM client using Vercel AI SDK.
 * Supports multiple providers via LLM_PROVIDER env var.
 */
export function createLLMClient(): LLMClient | null {
  const model = createModel();
  if (!model) return null;

  return {
    async chat(options: ChatCompletionOptions): Promise<string> {
      logger.debug({ messageCount: options.messages.length }, 'Sending chat request');

      const text = await withRetry(
        async () => {
          const result = await generateText({
            model,
            messages: options.messages,
            maxOutputTokens: options.maxTokens ?? 4096,
            temperature: options.temperature ?? 0.7,
          });
          return result.text;
        },
        DEFAULT_RETRY_CONFIG,
        'chat'
      );

      logger.debug({ responseLength: text.length }, 'Received chat response');
      return text;
    },

    async generateObject<T>(options: {
      schema: z.ZodSchema<T>;
      messages: ChatMessage[];
      maxTokens?: number;
      temperature?: number;
    }): Promise<T> {
      logger.debug({ messageCount: options.messages.length }, 'Sending structured output request');

      const object = await withRetry(
        async () => {
          const result = await generateObject({
            model,
            schema: options.schema,
            messages: options.messages,
            maxOutputTokens: options.maxTokens ?? 4096,
            temperature: options.temperature ?? 0.3,
          });
          return result.object;
        },
        DEFAULT_RETRY_CONFIG,
        'generateObject'
      );

      logger.debug('Received structured output response');
      return object;
    },

    getModel(): LanguageModel {
      return model;
    },
  };
}

/**
 * Extract resource name from Azure OpenAI endpoint URL.
 * Supports both formats:
 * - https://my-resource.openai.azure.com -> my-resource
 * - https://my-resource.cognitiveservices.azure.com -> my-resource
 */
function extractResourceName(endpoint: string): string {
  // Try openai.azure.com format first
  let match = endpoint.match(/https:\/\/([^.]+)\.openai\.azure\.com/);
  if (match) {
    return match[1];
  }
  // Try cognitiveservices.azure.com format
  match = endpoint.match(/https:\/\/([^.]+)\.cognitiveservices\.azure\.com/);
  if (match) {
    return match[1];
  }
  throw new Error(`Invalid Azure OpenAI endpoint format: ${endpoint}. Expected https://<resource>.openai.azure.com or https://<resource>.cognitiveservices.azure.com`);
}

// Singleton instance
let llmClient: LLMClient | null | undefined;

export function getLLMClient(): LLMClient | null {
  if (llmClient === undefined) {
    llmClient = createLLMClient();
  }
  return llmClient;
}
