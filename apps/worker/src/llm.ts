import pino from 'pino';
import { generateText, generateObject, LanguageModel } from 'ai';
import { createAzure } from '@ai-sdk/azure';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import {
  withRetry,
  isRetryableError,
  getRetryDelayFromError,
  type RetryConfig,
} from './retry.js';

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

// LLM-specific retry configuration (shorter delays than GitHub since LLM APIs recover faster)
const LLM_RETRY_CONFIG: Partial<RetryConfig> = {
  maxAttempts: 4,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

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
        {
          config: LLM_RETRY_CONFIG,
          operation: 'LLM chat',
          shouldRetry: isRetryableError,
          getRetryDelay: getRetryDelayFromError,
        }
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
        {
          config: LLM_RETRY_CONFIG,
          operation: 'LLM generateObject',
          shouldRetry: isRetryableError,
          getRetryDelay: getRetryDelayFromError,
        }
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
