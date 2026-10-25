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

/**
 * A request that got no HTTP answer at all. Node's fetch says only "fetch
 * failed"; what stopped it is the `code` on its `cause` (an AggregateError,
 * when a name resolved to several addresses, carries the code and an empty
 * message). The message names the host and the likely culprit, and keeps the
 * code for whoever reads a report.
 */
export function unreachable(url: string, err: unknown): OpenRouterError {
  return new OpenRouterError(`Could not reach OpenRouter at ${hostOf(url)}: ${reasonFor(causeCode(err), err)}`);
}

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'EAI_NODATA']);
const CUT_OFF_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'UND_ERR_SOCKET']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);
const NO_ROUTE_CODES = new Set(['ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EHOSTDOWN', 'EADDRNOTAVAIL']);

function reasonFor(code: string | undefined, err: unknown): string {
  if (code === undefined) return `${detailOf(err)}.`;
  if (DNS_CODES.has(code)) return `the name could not be looked up (${code}). Check the internet connection.`;
  if (code === 'ECONNREFUSED') return `the connection was refused (${code}). A firewall, VPN or proxy may be blocking it.`;
  if (CUT_OFF_CODES.has(code)) return `the connection was cut off (${code}). A firewall, VPN or proxy may be blocking it.`;
  if (TIMEOUT_CODES.has(code)) return `the connection timed out (${code}). Check the internet connection, VPN or firewall.`;
  if (NO_ROUTE_CODES.has(code)) return `there is no network route to it (${code}). Check the internet connection.`;
  if (/CERT|SSL|TLS/.test(code)) {
    return `its security certificate was not trusted (${code}). Antivirus, a VPN or a work network that inspects secure connections can cause this.`;
  }
  return `${detailOf(err)} (${code}).`;
}

/** The first string `code` on the error, its `cause` chain, or an AggregateError's `errors`. */
function causeCode(err: unknown, depth = 0): string | undefined {
  if (typeof err !== 'object' || err === null || depth > 5) return undefined;
  const r = err as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof r.code === 'string' && r.code.length > 0) return r.code;
  if (Array.isArray(r.errors)) {
    for (const inner of r.errors) {
      const c = causeCode(inner, depth + 1);
      if (c) return c;
    }
  }
  return causeCode(r.cause, depth + 1);
}

/** The deepest non-empty message along the `cause` chain: "fetch failed" says less than what caused it. */
function detailOf(err: unknown): string {
  let detail = err instanceof Error ? err.message : String(err);
  let e: unknown = err instanceof Error ? err.cause : undefined;
  for (let depth = 0; e instanceof Error && depth < 5; depth++, e = e.cause) {
    if (e.message) detail = e.message;
  }
  return detail;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** `GET /key`: 401 -> "OpenRouter rejected the API key"; any other non-2xx -> the body's `error.message`; no answer -> `unreachable`. Resolves on success. */
export async function validateKey(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const url = endpoint(baseUrl, 'key');
  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'GET', headers: authHeaders(apiKey) });
  } catch (e) {
    throw unreachable(url, e);
  }
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
    let res: Response;
    try {
      res = await fetchImpl(url, { method: 'GET', headers: authHeaders(apiKey) });
    } catch (e) {
      throw unreachable(url, e);
    }
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
