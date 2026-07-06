export interface ModelConfig {
  id: string;
  label: string;
  shortLabel: string;
  description: string;
  badge: "local" | "remote";
  provider: "ollama" | "openai-compatible";
  baseUrl: string;
  model: string;
  numCtx?: number;
  /** Model id to use for the /v1/embeddings endpoint, when the backend supports one (semantic schema filtering). */
  embeddingModel?: string;
  /** Parameter count in billions -- lets a caller pick by size (e.g. IRASS sending `paramsB: 27`) instead of by name. */
  paramsB: number;
}

export const AVAILABLE_MODELS: ModelConfig[] = [
  {
    id: "qwen2.5-coder-7b",
    label: "Qwen2.5 Coder 7B (Ollama, local, offline)",
    shortLabel: "Qwen2.5 Coder 7B",
    description: "Runs on this machine via Ollama. No network, no data leaves the building.",
    badge: "local",
    provider: "ollama",
    baseUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
    model: process.env.OLLAMA_MODEL ?? "qwen2.5-coder:7b",
    numCtx: Number(process.env.OLLAMA_NUM_CTX ?? 4096),
    paramsB: 7,
  },
  {
    id: "gemma-3-27b",
    label: "Gemma 3 27B (H200)",
    shortLabel: "Gemma 3 27B",
    description: "Hosted on a dedicated H200 GPU. Larger model, faster answers.",
    badge: "remote",
    provider: "openai-compatible",
    baseUrl: process.env.GEMMA_BASE_URL ?? "http://localhost:3001",
    model: process.env.GEMMA_MODEL ?? "gemma-3-27b",
    embeddingModel: process.env.GEMMA_EMBEDDING_MODEL ?? "gemma-3-27b",
    paramsB: 27,
  },
];

export const DEFAULT_MODEL_ID = process.env.DEFAULT_MODEL_ID ?? AVAILABLE_MODELS[0].id;

/**
 * Resolves a model either by explicit id or by parameter size in billions
 * (`paramsB`) -- the latter is for callers (e.g. IRASS) that want to pick
 * "how big a model" rather than name a specific one. `modelId` wins if both
 * are given. More entries can share the schema below as they're added;
 * `paramsB` only resolves cleanly while each size maps to a single model.
 */
export function getModelConfig(modelId?: string, paramsB?: number): ModelConfig {
  if (modelId) {
    const found = AVAILABLE_MODELS.find((m) => m.id === modelId);
    if (!found) {
      throw new Error(`Unknown modelId '${modelId}'. Available: ${AVAILABLE_MODELS.map((m) => m.id).join(", ")}`);
    }
    return found;
  }

  if (paramsB !== undefined) {
    const matches = AVAILABLE_MODELS.filter((m) => m.paramsB === paramsB);
    if (matches.length === 0) {
      const sizes = [...new Set(AVAILABLE_MODELS.map((m) => m.paramsB))].join(", ");
      throw new Error(`No model configured with ${paramsB}B parameters. Available sizes: ${sizes}`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Multiple models have ${paramsB}B parameters (${matches.map((m) => m.id).join(", ")}) -- specify modelId instead.`
      );
    }
    return matches[0];
  }

  return getModelConfig(DEFAULT_MODEL_ID);
}

export function listModelsForClient(): Omit<ModelConfig, "provider" | "baseUrl" | "model" | "numCtx" | "embeddingModel">[] {
  return AVAILABLE_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    shortLabel: m.shortLabel,
    description: m.description,
    badge: m.badge,
    paramsB: m.paramsB,
  }));
}
