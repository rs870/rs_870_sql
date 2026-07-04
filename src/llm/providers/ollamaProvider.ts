import { ModelConfig } from "../models";

export async function callOllama(system: string, user: string, config: ModelConfig): Promise<string> {
  const response = await fetch(`${config.baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      format: "json",
      stream: false,
      options: { num_ctx: config.numCtx ?? 4096 },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Ollama request failed (${response.status}). Is 'ollama serve' running and is model '${config.model}' pulled? ${body}`
    );
  }

  const data = (await response.json()) as { message: { role: string; content: string } };
  return data.message.content;
}
