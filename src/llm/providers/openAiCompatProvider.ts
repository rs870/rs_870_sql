import { ModelConfig } from "../models";

/**
 * Calls a self-hosted OpenAI-compatible chat endpoint (e.g. vLLM/TGI serving
 * Gemma on an H200 box) at `${baseUrl}/v1/chat/completions`. Same contract
 * as callOllama(): takes system/user text, returns the raw assistant text.
 */
export async function callOpenAiCompat(system: string, user: string, config: ModelConfig): Promise<string> {
  const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      stream: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Model server request failed (${response.status}) at ${config.baseUrl}. Is the OpenAI-compatible server for '${config.model}' running? ${body}`
    );
  }

  const data = (await response.json()) as { choices: { message: { role: string; content: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`Model server returned no content. Raw response: ${JSON.stringify(data)}`);
  }
  return content;
}
