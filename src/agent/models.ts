// OpenRouter's catalog side: key validation (`GET /key`), the model list
// (`GET /models`), and the pure helpers that turn that list into the
// `model` config option the sidecar advertises (docs/research/
// agent-protocol.md §2, api path). Wire shapes follow docs/research/
// openrouter-api.md §1 and §3 -- pricing values are strings in USD per
// token, `supported_parameters` and `architecture.input_modalities` are
// the two filters that decide whether a model can drive the tool loop.
// No session state lives here.

/** One entry of `GET /models` -> `data[]` (openrouter-api.md §3), trimmed to what the loop and the option builder read. */
export interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  pricing: { prompt: string; completion: string; image?: string; request?: string; input_cache_read?: string };
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters?: string[];
  top_provider?: { max_completion_tokens?: number | null };
}

/** Any failure OpenRouter reported (HTTP status or a mid-stream `error` chunk). `status` is the HTTP status / chunk `code` when one was given. */
export class OpenRouterError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
  }
}

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/** The two attribution headers from openrouter-api.md §1, sent on every request. */
export const ATTRIBUTION_HEADERS: Readonly<Record<string, string>> = {
  'HTTP-Referer': 'https://github.com/planetjc',
  'X-OpenRouter-Title': 'AnkiEngine',
};

export function authHeaders(apiKey: string, extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, ...ATTRIBUTION_HEADERS, ...(extra ?? {}) };
}

/** Best-effort `error.message` from an OpenRouter error body (openrouter-api.md §2.8); `undefined` when the body is not that shape. */
export async function readErrorMessage(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    const message = parsed?.error?.message;
    return typeof message === 'string' && message.length > 0 ? message : undefined;
  } catch {
    return undefined;
  }
}

/** Trailing-slash tolerant join of base URL and endpoint path. */
export function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** `GET /key`: 401 -> "OpenRouter rejected the API key"; any other non-2xx -> the body's `error.message`. Resolves on success. */
export async function validateKey(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(endpoint(baseUrl, 'key'), { method: 'GET', headers: authHeaders(apiKey) });
  if (res.ok) {
    await res.text().catch(() => undefined);
    return;
  }
  if (res.status === 401) throw new OpenRouterError('OpenRouter rejected the API key', 401);
  const message = await readErrorMessage(res);
  throw new OpenRouterError(message ?? `OpenRouter: HTTP ${res.status}`, res.status);
}

/** `GET /models` -> `data[]`. Follows a `next` page link when the server sends one (openrouter-api.md §3 says the list is paginated); bounded so a misbehaving server cannot loop it. */
export async function listModels(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<OpenRouterModel[]> {
  const out: OpenRouterModel[] = [];
  const seen = new Set<string>();
  let url = endpoint(baseUrl, 'models');
  for (let page = 0; page < 20; page++) {
    if (seen.has(url)) break;
    seen.add(url);
    const res = await fetchImpl(url, { method: 'GET', headers: authHeaders(apiKey) });
    if (!res.ok) {
      if (res.status === 401) throw new OpenRouterError('OpenRouter rejected the API key', 401);
      const message = await readErrorMessage(res);
      throw new OpenRouterError(message ?? `OpenRouter: HTTP ${res.status}`, res.status);
    }
    const body = (await res.json()) as { data?: unknown; next?: unknown };
    if (Array.isArray(body.data)) {
      for (const m of body.data) if (isModel(m)) out.push(m);
    }
    if (typeof body.next !== 'string' || body.next.length === 0) break;
    url = /^https?:\/\//.test(body.next) ? body.next : new URL(body.next, url).toString();
  }
  return out;
}

function isModel(m: unknown): m is OpenRouterModel {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.name === 'string';
}

/** Models that can run the loop: tool calling AND image input (agent-protocol.md §2). Sorted by display name. */
export function usableModels(models: OpenRouterModel[]): OpenRouterModel[] {
  return models
    .filter((m) => (m.supported_parameters ?? []).includes('tools') && (m.architecture?.input_modalities ?? []).includes('image'))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** USD per token (string) -> USD per million tokens, up to 2 decimals, trailing zeros trimmed: "0.000003" -> "3", "0.0000025" -> "2.5". */
export function perMillion(pricePerToken: string): string {
  const n = Number(pricePerToken) * 1e6;
  if (!Number.isFinite(n)) return '0';
  return String(Number(n.toFixed(2)));
}

/** The option label the app shows: `<name> · $<in>/M in · $<out>/M out`. */
export function modelOptionName(m: OpenRouterModel): string {
  return `${m.name} · $${perMillion(m.pricing.prompt)}/M in · $${perMillion(m.pricing.completion)}/M out`;
}

export const PREFERRED_MODEL_ID = 'anthropic/claude-sonnet-5';

/** `anthropic/claude-sonnet-5` when the usable list has it, else the first usable model. Throws when the list is empty -- there is nothing to default to. */
export function defaultModelId(usable: OpenRouterModel[]): string {
  const preferred = usable.find((m) => m.id === PREFERRED_MODEL_ID);
  if (preferred) return preferred.id;
  const first = usable[0];
  if (!first) throw new OpenRouterError('OpenRouter lists no model with tool calling and image input');
  return first.id;
}
