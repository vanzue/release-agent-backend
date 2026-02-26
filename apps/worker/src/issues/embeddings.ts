import pino from 'pino';

const logger = pino({ name: 'issue-embeddings', level: process.env.LOG_LEVEL ?? 'info' });

function requireAzureOpenAI() {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION;
  const modelId = process.env.ISSUE_EMBEDDING_MODEL_ID;
  if (!endpoint) throw new Error('Missing AZURE_OPENAI_ENDPOINT');
  if (!apiKey) throw new Error('Missing AZURE_OPENAI_API_KEY');
  if (!modelId) throw new Error('Missing ISSUE_EMBEDDING_MODEL_ID');
  return { endpoint, apiKey, apiVersion, modelId };
}

export async function embedTextAzureOpenAI(text: string): Promise<{ model: string; embedding: number[] }> {
  const { endpoint, apiKey, apiVersion, modelId } = requireAzureOpenAI();
  const baseURL = endpoint.replace(/\/?$/, '/');
  const url = apiVersion
    ? `${baseURL}openai/deployments/${encodeURIComponent(modelId)}/embeddings?api-version=${encodeURIComponent(apiVersion)}`
    : `${baseURL}openai/v1/embeddings`;

  const res: any = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
      ...(apiVersion ? {} : { model: modelId }),
      input: text,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.error({ status: res.status, body, url }, 'Azure OpenAI embeddings error');
    throw new Error(`Azure OpenAI embeddings error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as any;
  const embedding = data?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    logger.error({ data }, 'Unexpected embeddings response');
    throw new Error('Invalid embeddings response');
  }

  return { model: modelId, embedding: embedding.map((n: any) => Number(n)) };
}
