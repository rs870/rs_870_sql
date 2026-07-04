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
  },
];

export const DEFAULT_MODEL_ID = process.env.DEFAULT_MODEL_ID ?? AVAILABLE_MODELS[0].id;

export function getModelConfig(modelId: string | undefined): ModelConfig {
  const id = modelId ?? DEFAULT_MODEL_ID;
  const found = AVAILABLE_MODELS.find((m) => m.id === id);
  if (!found) {
    throw new Error(`Unknown modelId '${id}'. Available: ${AVAILABLE_MODELS.map((m) => m.id).join(", ")}`);
  }
  return found;
}

export function listModelsForClient(): Omit<ModelConfig, "provider" | "baseUrl" | "model" | "numCtx">[] {
  return AVAILABLE_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    shortLabel: m.shortLabel,
    description: m.description,
    badge: m.badge,
  }));
}
