// The embedded agent: one session = one conversation history, driven by a
// plain loop over OpenRouter `POST /chat/completions` (stream: true) that
// emits the same ACP `session/update` stream an external agent would
// (docs/research/agent-protocol.md §3-§4; wire shapes from docs/research/
// openrouter-api.md). The loop owns: block -> message mapping (system
// prompt from an `ape://system` resource, images/PDFs/text attachments),
// the request body (tools, reasoning effort, PDF plugin), the tool round
// (permission for write_file in `default` mode), error mapping to
// OpenRouterError, and cancellation via AbortController. Everything the
// model says about cards is the caller's prompt, never this file's.
import { readFileSync } from 'node:fs';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import type {
  ContentBlock,
  RequestPermissionOutcome,
  RequestPermissionParams,
  SessionUpdate,
  StopReason,
  ToolCallContent,
  UsageUpdate,
} from '../acp/protocol.js';
import { OpenRouterError, authHeaders, endpoint, readErrorMessage, unreachable, type OpenRouterModel } from './models.js';
import { TurnAccumulator, sseData, type ReasoningDetail, type StreamChunk, type StreamUsage } from './stream.js';
import {
  TOOL_DEFINITIONS,
  TOOL_KINDS,
  displayPath,
  errorMessage,
  isToolName,
  listDirTool,
  readFileTool,
  refusedText,
  resolveInside,
  toolTitle,
  writeFileTool,
  type ToolName,
} from './tools.js';

export type Effort = 'none' | 'low' | 'medium' | 'high';
export type EmbeddedMode = 'default' | 'acceptEdits';

export const EFFORTS: readonly Effort[] = ['none', 'low', 'medium', 'high'];
export const MODES: readonly EmbeddedMode[] = ['default', 'acceptEdits'];

/** §4: at most this many tool rounds per prompt, then `max_turn_requests`. */
export const MAX_TOOL_ROUNDS = 50;
/** §4: a 429 is retried once after this long. */
export const RATE_LIMIT_RETRY_MS = 2000;

export const SYSTEM_RESOURCE_URI = 'ape://system';
export const DEFAULT_SYSTEM_PROMPT = 'You are a careful assistant working inside one course folder.';

export interface EmbeddedSessionOptions {
  sessionId: string;
  baseUrl: string;
  apiKey: string;
  cwd: string;
  model: string;
  effort: Effort;
  mode: EmbeddedMode;
  models: OpenRouterModel[];
  onUpdate: (update: SessionUpdate) => void;
  onPermissionRequest: (params: RequestPermissionParams) => Promise<RequestPermissionOutcome>;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}

export interface EmbeddedSession {
  prompt(blocks: ContentBlock[]): Promise<StopReason>;
  cancel(): void;
  setModel(id: string): void;
  setEffort(e: Effort): void;
  setMode(m: EmbeddedMode): void;
  readonly model: string;
  readonly effort: Effort;
  readonly mode: EmbeddedMode;
  readonly busy: boolean;
}

// ---- wire messages (openrouter-api.md §2.2, §2.3) ------------------------

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } };

type WireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
      reasoning_details?: ReasoningDetail[];
    }
  | { role: 'tool'; tool_call_id: string; name?: string; content: string };

export function createEmbeddedSession(opts: EmbeddedSessionOptions): EmbeddedSession {
  return new Session(opts);
}

class Session implements EmbeddedSession {
  private readonly opts: EmbeddedSessionOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly history: WireMessage[] = [];
  private systemPrompt = DEFAULT_SYSTEM_PROMPT;
  private _model: string;
  private _effort: Effort;
  private _mode: EmbeddedMode;
  private controller: AbortController | null = null;
  private toolCounter = 0;

  constructor(opts: EmbeddedSessionOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this._model = opts.model;
    this._effort = opts.effort;
    this._mode = opts.mode;
  }

  get model(): string {
    return this._model;
  }
  get effort(): Effort {
    return this._effort;
  }
  get mode(): EmbeddedMode {
    return this._mode;
  }
  get busy(): boolean {
    return this.controller !== null;
  }

  setModel(id: string): void {
    if (!this.opts.models.some((m) => m.id === id)) throw new RangeError(`unknown model: ${id}`);
    this._model = id;
  }
  setEffort(e: Effort): void {
    if (!EFFORTS.includes(e)) throw new RangeError(`unknown effort: ${String(e)}`);
    this._effort = e;
  }
  setMode(m: EmbeddedMode): void {
    if (!MODES.includes(m)) throw new RangeError(`unknown mode: ${String(m)}`);
    this._mode = m;
  }

  cancel(): void {
    this.controller?.abort();
  }

  async prompt(blocks: ContentBlock[]): Promise<StopReason> {
    if (this.controller) throw new Error('session has a turn in progress');
    const controller = new AbortController();
    this.controller = controller;
    try {
      return await this.runTurn(blocks, controller.signal);
    } finally {
      this.controller = null;
    }
  }

  // ---- the loop ---------------------------------------------------------

  private async runTurn(blocks: ContentBlock[], signal: AbortSignal): Promise<StopReason> {
    this.history.push(this.userMessage(blocks));
    let toolRounds = 0;
    for (;;) {
      if (signal.aborted) return 'cancelled';
      const acc = new TurnAccumulator();
      try {
        await this.streamOnce(acc, signal);
      } catch (e) {
        if (signal.aborted) {
          if (acc.text.length) this.history.push({ role: 'assistant', content: acc.text });
          return 'cancelled';
        }
        throw e;
      }
      if (signal.aborted) {
        if (acc.text.length) this.history.push({ role: 'assistant', content: acc.text });
        return 'cancelled';
      }

      const calls = acc.completedToolCalls();
      const assistant: WireMessage = { role: 'assistant', content: acc.text.length || !calls.length ? acc.text : null };
      if (calls.length) assistant.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
      if (acc.reasoningDetails.length) assistant.reasoning_details = acc.reasoningDetails;
      this.history.push(assistant);

      if (!calls.length) return stopReasonOf(acc.finishReason);
      // Every tool call in the history is answered before the turn ends, run
      // or not: a call with no tool message after it is a request providers
      // refuse, and the session is reused -- one Stop during a permission
      // prompt used to fail every later stage on the connection.
      const unanswered = (from: number, why: string): void => {
        for (const call of calls.slice(from)) this.history.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: why });
      };
      if (toolRounds >= MAX_TOOL_ROUNDS) {
        unanswered(0, `Not run: this turn reached its limit of ${MAX_TOOL_ROUNDS} tool rounds.`);
        return 'max_turn_requests';
      }
      toolRounds++;
      for (const [i, call] of calls.entries()) {
        if (signal.aborted) {
          unanswered(i, 'Not run: the user cancelled the turn.');
          return 'cancelled';
        }
        const text = await this.runTool(call.id, call.name, call.arguments, signal);
        this.history.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: text });
        if (signal.aborted) {
          unanswered(i + 1, 'Not run: the user cancelled the turn.');
          return 'cancelled';
        }
      }
    }
  }

  private async streamOnce(acc: TurnAccumulator, signal: AbortSignal): Promise<void> {
    const res = await this.postWithRetry(signal);
    if (!res.body) throw new OpenRouterError('OpenRouter returned an empty response body', res.status);
    for await (const data of sseData(res.body)) {
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(data) as StreamChunk;
      } catch {
        continue;
      }
      if (chunk.error) {
        const code = typeof chunk.error.code === 'number' ? chunk.error.code : undefined;
        throw new OpenRouterError(chunk.error.message ?? 'OpenRouter: stream error', code);
      }
      const { content, reasoning } = acc.apply(chunk);
      if (content) this.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: content } });
      if (reasoning) this.emit({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: reasoning } });
      if (chunk.usage) this.emitUsage(chunk.usage);
    }
  }

  private async postWithRetry(signal: AbortSignal): Promise<Response> {
    let res = await this.post(signal);
    if (res.status === 429) {
      await res.text().catch(() => undefined);
      await sleep(RATE_LIMIT_RETRY_MS, signal);
      res = await this.post(signal);
    }
    if (res.ok) return res;
    if (res.status === 401) throw new OpenRouterError('OpenRouter rejected the API key', 401);
    if (res.status === 402) throw new OpenRouterError('OpenRouter: insufficient credits', 402);
    const message = await readErrorMessage(res);
    if (res.status === 429) throw new OpenRouterError(message ?? 'OpenRouter: rate limited', 429);
    throw new OpenRouterError(message ?? `OpenRouter: HTTP ${res.status}`, res.status);
  }

  private async post(signal: AbortSignal): Promise<Response> {
    try {
      return await this.fetchImpl(endpoint(this.opts.baseUrl, 'chat/completions'), {
        method: 'POST',
        headers: { ...authHeaders(this.opts.apiKey, this.opts.headers), 'Content-Type': 'application/json' },
        body: JSON.stringify(this.requestBody()),
        signal,
      });
    } catch (e) {
      if (signal.aborted) throw e;
      throw unreachable(this.opts.baseUrl, e);
    }
  }

  private requestBody(): Record<string, unknown> {
    const model = this.currentModel();
    const body: Record<string, unknown> = {
      model: this._model,
      messages: [{ role: 'system', content: this.systemPrompt }, ...this.history],
      stream: true,
      tools: TOOL_DEFINITIONS,
    };
    if (this._effort !== 'none' && (model?.supported_parameters ?? []).includes('reasoning')) {
      body.reasoning = { effort: this._effort };
    }
    if (this.history.some(hasFilePart)) {
      const native = (model?.architecture?.input_modalities ?? []).includes('file');
      body.plugins = [{ id: 'file-parser', pdf: { engine: native ? 'native' : 'mistral-ocr' } }];
    }
    return body;
  }

  private currentModel(): OpenRouterModel | undefined {
    return this.opts.models.find((m) => m.id === this._model);
  }

  // ---- tools ---------------------------------------------------------------

  private async runTool(toolCallId: string, name: string, rawArgs: string, signal: AbortSignal): Promise<string> {
    if (!isToolName(name)) {
      this.emit({ sessionUpdate: 'tool_call', toolCallId, title: name || '(unnamed tool)', kind: 'other', status: 'pending' });
      return this.finishTool(toolCallId, false, `Unknown tool: ${name}`);
    }
    let args: { path?: unknown; content?: unknown };
    try {
      args = rawArgs.trim().length ? (JSON.parse(rawArgs) as typeof args) : {};
    } catch (e) {
      this.emit({ sessionUpdate: 'tool_call', toolCallId, title: toolTitle(name, '?'), kind: TOOL_KINDS[name], status: 'pending' });
      return this.finishTool(toolCallId, false, `Invalid tool arguments: ${errorMessage(e)}`);
    }
    const given = typeof args.path === 'string' ? args.path : '';
    const resolved = resolveInside(this.opts.cwd, given || '.');
    this.emit({ sessionUpdate: 'tool_call', toolCallId, title: toolTitle(name, resolved.rel), kind: TOOL_KINDS[name], status: 'pending' });
    if (!given) return this.finishTool(toolCallId, false, 'Missing required argument: path');
    if (!resolved.inside) return this.finishTool(toolCallId, false, refusedText(given));

    switch (name) {
      case 'read_file': {
        const r = readFileTool(resolved);
        return this.finishTool(toolCallId, r.ok, r.text);
      }
      case 'list_dir': {
        const r = listDirTool(resolved);
        return this.finishTool(toolCallId, r.ok, r.text);
      }
      case 'write_file': {
        if (typeof args.content !== 'string') return this.finishTool(toolCallId, false, 'Missing required argument: content');
        if (this._mode === 'default') {
          const allowed = await this.askWritePermission(toolCallId, name, resolved.rel, resolved.abs, signal);
          if (!allowed) return this.finishTool(toolCallId, false, `Write denied by the user: ${resolved.rel}`);
        }
        const r = writeFileTool(resolved, args.content);
        return this.finishTool(toolCallId, r.ok, r.text);
      }
    }
  }

  /** §3: raised before every write_file in `default` mode. `allow-always` flips the session to `acceptEdits` for the rest of its life. */
  private async askWritePermission(toolCallId: string, name: ToolName, rel: string, abs: string, signal: AbortSignal): Promise<boolean> {
    const params: RequestPermissionParams = {
      sessionId: this.opts.sessionId,
      toolCall: { toolCallId, title: toolTitle(name, rel), kind: 'edit', status: 'pending', locations: [{ path: abs }] },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    };
    let outcome: RequestPermissionOutcome;
    try {
      outcome = await raceAbort(this.opts.onPermissionRequest(params), signal);
    } catch {
      return false;
    }
    if (signal.aborted || outcome.outcome !== 'selected') return false;
    if (outcome.optionId === 'allow-always') {
      this._mode = 'acceptEdits';
      this.emit({ sessionUpdate: 'current_mode_update', currentModeId: 'acceptEdits' });
      return true;
    }
    return outcome.optionId === 'allow-once';
  }

  private finishTool(toolCallId: string, ok: boolean, text: string): string {
    const content: ToolCallContent[] = [{ type: 'content', content: { type: 'text', text } }];
    this.emit({ sessionUpdate: 'tool_call_update', toolCallId, status: ok ? 'completed' : 'failed', content });
    return text;
  }

  // ---- updates ---------------------------------------------------------------

  private emit(update: SessionUpdate): void {
    this.opts.onUpdate(update);
  }

  private emitUsage(usage: StreamUsage): void {
    const update = {
      sessionUpdate: 'usage_update',
      used: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
      size: this.currentModel()?.context_length ?? 0,
      _meta: {
        cost: usage.cost ?? 0,
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
      },
    } as UsageUpdate;
    this.emit(update);
  }

  // ---- blocks -> user message (§4) -------------------------------------------

  private userMessage(blocks: ContentBlock[]): WireMessage {
    const parts: ContentPart[] = [];
    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          parts.push({ type: 'text', text: block.text });
          break;
        case 'image':
          parts.push({ type: 'image_url', image_url: { url: dataUrl(block.mimeType, block.data) } });
          break;
        case 'audio':
          parts.push({ type: 'input_audio', input_audio: { data: block.data, format: block.mimeType.split('/')[1] ?? 'wav' } });
          break;
        case 'resource_link':
          parts.push(this.attachmentPart(pathOfUri(block.uri, this.opts.cwd), block.mimeType));
          break;
        case 'resource': {
          const r = block.resource;
          if (r.uri === SYSTEM_RESOURCE_URI && 'text' in r) {
            this.systemPrompt = r.text;
            break;
          }
          if ('text' in r) {
            parts.push({ type: 'text', text: fenced(r.uri, r.text) });
          } else {
            const mime = r.mimeType ?? '';
            if (mime.startsWith('image/')) parts.push({ type: 'image_url', image_url: { url: dataUrl(mime, r.blob) } });
            else if (mime === 'application/pdf') parts.push({ type: 'file', file: { filename: basename(r.uri) || 'document.pdf', file_data: dataUrl(mime, r.blob) } });
            else parts.push({ type: 'text', text: fenced(r.uri, Buffer.from(r.blob, 'base64').toString('utf8')) });
          }
          break;
        }
      }
    }
    return { role: 'user', content: parts };
  }

  private attachmentPart(path: string, declaredMime?: string): ContentPart {
    const mime = declaredMime ?? mimeOfExtension(extname(path));
    const heading = displayPath(this.opts.cwd, path);
    if (mime === 'application/pdf') {
      return { type: 'file', file: { filename: basename(path), file_data: dataUrl(mime, readAttachment(path).toString('base64')) } };
    }
    if (mime.startsWith('image/')) {
      return { type: 'image_url', image_url: { url: dataUrl(mime, readAttachment(path).toString('base64')) } };
    }
    return { type: 'text', text: fenced(heading, readAttachment(path).toString('utf8')) };
  }
}

// ---- helpers ----------------------------------------------------------------

function stopReasonOf(finishReason: string | null): StopReason {
  switch (finishReason) {
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

function hasFilePart(m: WireMessage): boolean {
  return m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p.type === 'file');
}

function dataUrl(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
}

/** `### <path>` heading plus the body in a fence (§4: "its text, fenced, with the path as a heading"). */
function fenced(heading: string, text: string): string {
  return `### ${heading}\n\n\`\`\`\n${text}\n\`\`\``;
}

/** `file://` URI -> filesystem path (decoded); anything else is taken as a path, relative ones against cwd. No node:url, by the dependency rule. */
function pathOfUri(uri: string, cwd: string): string {
  if (uri.startsWith('file://')) {
    let rest = uri.slice('file://'.length);
    const slash = rest.indexOf('/');
    if (slash > 0) rest = rest.slice(slash); // drop a host component such as `localhost`
    return decodeURIComponent(rest);
  }
  return isAbsolute(uri) ? uri : resolve(cwd, uri);
}

function readAttachment(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (e) {
    throw new Error(`cannot read attachment ${path}: ${errorMessage(e)}`);
  }
}

function mimeOfExtension(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.pdf':
      return 'application/pdf';
    default:
      return 'text/plain';
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolveSleep();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Resolves with `p`, or rejects as soon as `signal` aborts -- so a pending permission prompt cannot hold a cancelled turn open. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolveRace, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolveRace(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}
