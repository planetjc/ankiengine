# Sidecar protocol, part 2: agents

Extends `sidecar-protocol.md` (§1–§3 framing, lifecycle and error rules all
apply unchanged) with the methods the chat needs. Written from
`agent-install-and-auth.md` (how Zed does it), `claude-adapter-auth.md`
(sign-in on the wire), `openrouter-api.md` (the key tier), and
`acp-protocol.md`. Tests under `test/sidecar/agent-*.test.ts` and
`test/agent/` are written from this page by contexts that have not seen
`src/sidecar/agent*.ts`, `src/agents/` or `src/agent/`.

Two kinds of provider sit behind one session surface:

- **ACP agents** — anything in the public ACP registry (Claude, Gemini,
  Codex, …), installed on demand, spoken to through `src/acp`.
- **API providers** — OpenRouter first. The sidecar runs the agent loop
  itself (`src/agent/`), and emits the *same* update stream as an ACP agent.

The app never learns which kind it is talking to after `agent/connect`.

## 1. Provider management: `agents/*`

State lives under a **data directory** the app passes on every call that
needs it (`dataDir`), never a hardcoded path: `<dataDir>/registry.json`
(cache), `<dataDir>/npx/<id>/` (npm installs, one prefix per agent).

### `agents/list`
params `{ dataDir: string, registryUrl?: string, refresh?: boolean }` →
```
{ providers: Provider[], registry: { fetchedAt: string | null, url: string, error: string | null } }
```
`Provider` is
```
{ id: string, kind: "acp" | "api", name: string, description: string,
  version: string | null,           // registry version (acp) or null (api)
  installed: boolean,               // api providers: always true
  installedVersion: string | null,
  distribution: "npx" | "binary" | "uvx" | null,   // acp only
  installable: boolean }            // acp: distribution === "npx" (binary/uvx are listed, not installable yet)
```
- The registry is `GET <registryUrl>` (default
  `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`),
  cached to `<dataDir>/registry.json` and re-fetched when the cache is
  missing, older than one hour, or `refresh: true`. A fetch failure with a
  cache present uses the cache and reports `error`; with no cache it
  reports `error` and lists only the built-in api providers.
- Registry entries map by `id`, `name`, `description`, `version`, and the
  one key present in `distribution`. Entries lacking `id`/`name`/
  `distribution` are skipped.
- Built-in api providers, always present and always first:
  `{ id: "openrouter", kind: "api", name: "OpenRouter", description: "Any
  model, one API key", version: null, installed: true, installedVersion:
  null, distribution: null, installable: false }`.
- `installedVersion` is read from `<dataDir>/npx/<id>/node_modules/<package>/package.json`.

### `agents/install`
params `{ dataDir, id, npm?: { registry?: string } }` →
`{ id, package: string, version: string, bin: string }`

Runs `npm install --prefix <dataDir>/npx/<id> --save-exact --no-audit --no-fund
<package>@<version>` — the version from the registry entry — using **the
sidecar's own Node** (`process.execPath`) and npm resolved as: env
`APE_NPM_CLI` (path to `npm-cli.js`), else the `npm-cli.js` beside
`process.execPath` (`<dir>/../lib/node_modules/npm/bin/npm-cli.js`), else
`npm` on PATH. `npm.registry` (or env `APE_NPM_REGISTRY`) is passed as
`--registry`. Every stdout/stderr line from npm is forwarded as a
notification `agents/progress { id, stream: "stdout" | "stderr", line }`.
`bin` is the resolved absolute path of the package's `bin` entry (the sole
entry, or the one named after the package's unscoped name), read from the
installed `package.json`. Non-zero npm exit → `-32000` with npm's own
account of the error in the message: the first `npm error` line that is not a
detail key (`code`, `syscall`, `path`, `dest`, `errno`) or the closing "A
complete log of this run can be found in …", which is all the last line ever
says. An install that exits 0 but leaves out an optional dependency built for
this platform (`…-<os>-<arch>`, how the Claude agent ships its program) →
`-32000` too. One install at a time per agent: a second `agents/install` for
the same id while one runs gets the first one's result. Before npm runs, the
`node_modules/[@scope/].<name>-<8 chars>` folders an earlier install cut short
left behind are removed (npm picks the same name every time, so one leftover
fails every later install with ENOTEMPTY). An entry whose distribution is not
`npx` → `-32602`.

### `agents/uninstall`
params `{ dataDir, id }` → `{ id, removed: boolean }` — removes
`<dataDir>/npx/<id>` recursively; `false` if it did not exist.

## 2. Sessions: `agent/*`

One **connection** per provider process (or per API key); one **session**
per conversation. Ids are opaque strings minted by the sidecar.

### `agent/connect`
params
```
{ provider: string,                // a Provider.id
  dataDir: string, cwd: string,     // cwd: the course folder
  apiKey?: string,                  // api providers only; never logged, never written
  extraArgs?: string[], env?: Record<string,string> }
```
→
```
{ connectionId: string, provider: string, kind: "acp" | "api",
  agent: { name: string, version: string } | null,
  authStatus: { kind: string, label: string } | null,   // last _auth/status_update seen, or null
  authMethods: AuthMethod[],                            // ACP #5.1 shape, [] for api providers
  session: null | {
    sessionId: string,
    modes: SessionModeState | null,
    configOptions: SessionConfigOption[] | null,
    commands: AvailableCommand[] } ,
  authRequired: boolean }
```
ACP path: resolve `bin` as `agents/install` does (`-32000` "not installed"
if absent), spawn `node <bin> <registry args> <extraArgs>` via
`src/acp`'s `connect()` with `clientCapabilities: { auth: { terminal: true } }`,
then `newSession({ cwd })`. If `newSession` fails with the agent's
auth-required error (`code` -32000 with `data.reason` or message matching
`/auth/i` — record the exact shape the first time a real agent produces it),
return `session: null, authRequired: true` **and keep the connection open**
so `agent/login` can use it. Otherwise pin `setMode('default')` when modes
are present (Handoff: "the one thing that will bite you"), and return the
session.

API path (`openrouter`): `apiKey` required (`-32602`). Validate with
`GET /api/v1/key` (`-32000` on 401 with message `OpenRouter rejected the API
key`). `session.configOptions` is
```
[{ id: "model",  type: "select", name: "Model",  currentValue: <default>, options: [{ value: <model id>, name: "<name> · $<prompt>/M in · $<completion>/M out" }, …] },
 { id: "effort", type: "select", name: "Reasoning effort", currentValue: "medium", options: [{value:"none",name:"None"},{value:"low",name:"Low"},{value:"medium",name:"Medium"},{value:"high",name:"High"}] }]
```
built from `GET /api/v1/models` filtered to models whose
`supported_parameters` includes `tools` and whose `input_modalities`
includes `image`, sorted by name; `<default>` is `anthropic/claude-sonnet-5`
if listed else the first. `modes` is
`{ currentModeId: "default", availableModes: [{id:"default",name:"Manual",description:"Always ask before writing files"},{id:"acceptEdits",name:"Accept edits",description:"Write files without asking"}] }`.
`commands` is `[]`. The base URL is `https://openrouter.ai/api/v1` unless env
`APE_OPENROUTER_BASE_URL` overrides it (tests point it at a local fake).

### `agent/login`
params `{ connectionId, methodId }` → `{ methodId, exitCode: number | null, authenticated: boolean }`

- terminal-type method (ACP #5.3): take `client.terminalAuthLaunch(methodId)`,
  spawn it with `stdin` closed, forward each output line as
  `agent/loginOutput { connectionId, stream, line }`, wait for exit. Then
  **reconnect**: close the old connection, spawn afresh with the same
  arguments, `initialize` again, and read the resulting `_auth/status_update`
  (wait up to 3 s for one). `authenticated` is `authStatus.kind !== "none"`.
  The connection keeps its `connectionId`; a following `agent/connect` is not
  required — the response also carries the same `session` object
  `agent/connect` would, created on the new connection.
- agent-type method: `client.authenticate(methodId)`; `exitCode: null`;
  `authenticated: true` if it resolved.
- api providers → `-32602`.

### `agent/newSession`
params `{ connectionId }` → the same `session` object `agent/connect` returns,
for a second, independent session on the same connection — the adjudicator
that APP.md requires to have written none of the cards. ACP: `session/new`
again (mode pinned as on connect); api: a fresh embedded session with the
connection's models, default model and effort.

### `agent/status`
params `{ connectionId }` → `{ connectionId, provider, kind, authStatus, authMethods, sessions: string[] }`

### `agent/prompt`
params `{ sessionId, blocks: ContentBlock[] }` — ACP content blocks
(`text`, `image` (base64 + mimeType), `resource_link` (a file path as
`file://` uri, with `mimeType`), `resource` (embedded text)) →
`{ stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" }`.
While the turn runs, every update is a notification
`agent/update { sessionId, update: SessionUpdate }` in ACP's exact shapes
(`agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
`tool_call_update`, `usage_update`, `available_commands_update`,
`current_mode_update`, `config_option_update`). A second `agent/prompt` on a
session mid-turn is never refused -- the chat and the stages share the writer
session, and a message refused there never reached the agent:

- where the agent advertises steering (`InitializeResponse._meta.steering.supported`,
  claude-agent-acp's `_session/steering`), it goes into the running turn and
  the agent reads it at its next step; the result is that turn's end, as
  `{ stopReason, steered: true }`. Not while the turn is being cancelled.
- otherwise it is held and runs when the turn ends, in the order sent. A held
  prompt whose session closes first → `-32000` `"session <id> closed before
  this message reached the agent"`.

Either way the app is told at once: `agent/delivery { sessionId, steered }`.
Each turn is bracketed by `agent/turn { sessionId, running: true | false }`,
so the app knows a turn is running whoever started it.

After `agent/cancel` ends a turn, the next prompt on that session goes out
with a leading text block saying the person pressed Stop and the agent must
not resume that work unless the message plainly asks: Stop alone tells the
agent nothing, and it read the next short message as leave to carry on.

### `agent/cancel`
params `{ sessionId }` → `{}`; the in-flight `agent/prompt` resolves
`"cancelled"`.

### `agent/setMode` `{ sessionId, modeId }` → `{ modes: SessionModeState }`
### `agent/setConfigOption` `{ sessionId, id, value }` → `{ configOptions: SessionConfigOption[] }`
Both pass through to ACP (#17) or update the embedded session's state; an
unknown id/value → `-32602`.

### `agent/disconnect` `{ connectionId }` → `{}` — closes every session and
reaps the process. Also happens for all connections on `sidecar/shutdown`
and EOF.

## 3. Reverse direction: `agent/requestPermission`

The sidecar sends a **request** (with an id) to the app:
```
{ "jsonrpc":"2.0", "id": <n>, "method": "agent/requestPermission",
  "params": { "sessionId", "toolCall": ToolCallUpdate-shaped, "options": PermissionOption[] } }
```
and the app answers `{ "result": { "outcome": { "outcome": "selected", "optionId" } | { "outcome": "cancelled" } } }`.
Shapes are ACP #14 verbatim. An `error` response or a `cancelled` outcome
denies. For ACP agents this is the agent's own `session/request_permission`
relayed; for the embedded agent it is raised before every `write_file` when
the mode is `default`, with options `allow-once` (`allow_once`),
`allow-always` (`allow_always`, switches the session to `acceptEdits`) and
`reject` (`reject_once`). Ids for reverse requests are minted from a
separate counter and are numbers.

Also forwarded: `agent/authStatus { connectionId, authStatus }` whenever an
ACP agent sends `_auth/status_update`.

## 4. The embedded agent (`src/agent/`, OpenRouter)

A plain loop over `POST /chat/completions` with `stream: true`:

- `messages` = `[system, …history]`. The **system prompt is supplied by the
  caller** on `agent/prompt` as a leading `resource` block with
  `uri: "ape://system"` — the app builds it from the bundled method file;
  the sidecar adds nothing about cards. With no such block the system
  prompt is a one-line identity string.
- `blocks` map: `text` → text part; `image` → `image_url` data URL;
  `resource_link` with `mimeType: application/pdf` → `file` part (base64,
  `plugins: [{ id: "file-parser", pdf: { engine: "native" } }]` when the
  model's `input_modalities` includes `file`, else `mistral-ocr`);
  `resource_link` to an image → `image_url`; `resource_link` to anything
  else → its text, fenced, with the path as a heading.
- `tools`: `read_file { path }`, `write_file { path, content }`, `list_dir
  { path }`, all paths resolved against the session `cwd`; a path escaping
  `cwd` → the tool returns an error string, the loop continues. `write_file`
  raises `agent/requestPermission` first (§3) unless mode is `acceptEdits`.
- `reasoning: { effort }` is sent when the chosen model's
  `supported_parameters` includes `reasoning` and effort ≠ `none`;
  `reasoning_details` from an assistant message are passed back verbatim.
- Streaming: SSE `data:` lines, `: OPENROUTER PROCESSING` comments skipped,
  `[DONE]` ends; `delta.content` → `agent_message_chunk`; `delta.reasoning`
  → `agent_thought_chunk`; `delta.tool_calls[]` accumulated by `index`
  (`id`, `function.name`, `function.arguments` fragments concatenated); a
  chunk carrying `usage` → `usage_update { used: total_tokens, size: <model
  context_length>, _meta: { cost: usage.cost, promptTokens, completionTokens,
  cachedTokens, reasoningTokens } }`; an `error` chunk → the turn ends with
  `-32000` carrying `error.message`.
- Each tool call emits `tool_call { toolCallId, title, kind: "read" | "edit"
  | "search", status: "pending" }` then `tool_call_update { status:
  "completed" | "failed", content: [{type:"content", content:{type:"text", text}}] }`;
  its result goes back as a `role: "tool"` message; the loop re-requests
  until `finish_reason` ≠ `tool_calls`. At most 50 tool rounds per prompt →
  `stopReason: "max_turn_requests"`.
- HTTP 401 → `-32000` `"OpenRouter rejected the API key"`; 402 → `-32000`
  `"OpenRouter: insufficient credits"`; 429 → retry once after 2 s, then
  `-32000`; other non-2xx → `-32000` with `error.message`.
- `agent/cancel` aborts the fetch; the turn resolves `"cancelled"` and the
  partial assistant text is kept in history.

## 5. What the oracles must prove

- `agents/list` with a local fake registry (node:http): built-in first,
  registry entries mapped, cache written, cache used on fetch failure,
  `refresh` re-fetches, malformed entries skipped.
- `agents/install` against a local fake npm registry serving one packument
  + tarball: prefix layout, `bin` resolution, progress notifications carry
  npm's lines, non-npx distribution → `-32602`, failing install → `-32000`.
- `agent/connect` ACP over `test/acp/mock-agent.ts` scenarios: the frame
  sent advertises `auth.terminal`; `setMode('default')` is sent when modes
  exist; `authRequired` path keeps the connection; `agent/prompt` relays
  every update kind as `agent/update`; `agent/requestPermission` round-trips
  the app's answer to the agent; `cancel`; two connections isolated;
  `disconnect` reaps.
- `agent/login` terminal path with a fake login script that prints two
  lines and exits 0: `loginOutput` lines observed in order, reconnect
  happens (the mock sees a second `initialize`), `authenticated` reflects
  the second connection's `_auth/status_update`.
- `agent/connect` for `openrouter` against a local fake (node:http) that
  serves `/key`, `/models`, `/chat/completions` SSE: key rejection, model
  option construction and default, effort option, a text turn, a tool-call
  turn with `read_file`/`write_file`/`list_dir` (write asks permission in
  `default`, does not in `acceptEdits`, deny leaves no file), path escape
  refused, reasoning chunks, usage/cost, error chunk, 402, cancel.
- Nothing in any response or notification contains the API key.
