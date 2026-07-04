import { ModelConfig } from "../models";

/**
 * Calls a self-hosted OpenAI-compatible embeddings endpoint
 * (`${baseUrl}/v1/embeddings`) -- the same H200 box that serves chat
 * completions for Gemma. Used for semantic schema filtering (see
 * ../schemaFilter.ts); throws if the backend doesn't support embeddings so
 * the caller can fall back to keyword-based filtering.
 */
export async function embedTexts(texts: string[], config: ModelConfig): Promise<number[][]> {
  const response = await fetch(`${config.baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.embeddingModel ?? config.model,
      input: texts,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Embeddings request failed (${response.status}) at ${config.baseUrl}. Does '${config.embeddingModel ?? config.model}' support /v1/embeddings? ${body}`
    );
  }

  const data = (await response.json()) as { data: { embedding: number[]; index: number }[] };
  if (!Array.isArray(data.data) || data.data.length !== texts.length) {
    throw new Error(`Embeddings response had unexpected shape: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}
