# A.P.E.

Deck-pipeline structural checks, a `.apkg` (Anki package) writer, a CLI over
both, an ACP (Agent Client Protocol) client, and a stdio sidecar that exposes
all of it to the desktop app in `app/` (`docs/APP.md`), in TypeScript. Every claim
about what works here is backed by a command in [Status](#status) that was
actually run. The letters stand for **Anki Process Engine**, which the method's own
repository has been called all along and which the site now says out loud.

## Use it

Download the desktop app from <https://planetjc.github.io/ape-go-bananas/>
(`docs/APP.md`). Make a deck, drop the lecture's files on the window —
slides as PDF, the transcript, the objectives — pick an agent you already
pay for once in Settings (a Claude, Gemini or Codex subscription, or any
model with an OpenRouter key), and run the steps in order: extract,
organize, cards, audit, export. Each result is shown before the next step
runs. Nothing is uploaded; the agent runs on your computer, in the deck's
folder. The browser tool at `/tool/` checks a finished `deck.json` and
exports the `.apkg` with nothing installed.

For development, the same shell runs in a browser without building the
app: `npx -p github:planetjc/ape-go-bananas ape-bridge` starts the engine
on this machine and opens the tool page attached to it (`src/bridge/`,
Node ≥ 20). It is a developer route, not advertised on the pages.

## Requirements

- Node 24.12.0, pinned in `.nvmrc`, to develop and test. The bridge and the
  browser page need only Node 20 (`engines`), and say so. A system-default `node` on an older major
  will run the wrong runtime silently; use the pinned version explicitly if
  your shell isn't already picking up `.nvmrc`.
- Zero runtime dependencies. `typescript` and `@types/node` are the only
  devDependencies. Tests run on `node --test`, not a separate framework.

## Build and test

```sh
npm install
npm run build      # tsc: src/**/*.ts -> dist/**/*.js (+ .d.ts)
npm run typecheck  # builds, then tsc --noEmit over src + test together
npm test           # builds, then runs dist-backed tests under node --test
```

## CLI

```sh
npm run build
node dist/cli/index.js <command> [args]      # or: ./dist/cli/index.js ... (executable, shebang)
# or, once installed/linked (package.json's "bin"): ape <command> [args]
```

Three subcommands, each `-h`/`--help`-able on its own. `check` and `review`
mirror `tools/check_deck.py` and `tools/render_review.py` from the engine
repo closely enough that a user of those two scripts should recognize both
immediately; `export` has no Python original — it is this project's own
replacement for the AnkiConnect hand-off step, using `src/apkg` instead.

- **`ape check <deck.json> [--no-media] [--transcript <file>]... [--inventory <file>]`**
  Runs the structural checks (`src/checks`) and prints the exact report
  `check_deck.py` prints, in the same order (`docs/research/check-deck-contract.md`
  §9). Exit codes match the original: `0` clean, `1` the deck has findings
  (or a deck/transcript/inventory failed to load), `2` a usage error or a
  deck that parses but names zero notes.
- **`ape review <deck.json> [-o <out.html>]`**
  Renders one self-contained HTML review page (`src/checks`'
  `renderReview`) — every note's front faces, back, and Extra block. `-o`
  defaults to `review.html` next to `deck.json`, the same default
  `render_review.py` uses.
- **`ape export <deck.json> [-o <out.apkg>] [--deck-name <name>] [--media-dir <dir>]`**
  Writes a real `.apkg` via `src/apkg`'s `writeApkg`. Each note goes into
  the deck its own `deckName` names, so a multi-deck `deck.json` (an exam
  deck with a subdeck per chapter) is one package; `--deck-name` puts every
  note into that one deck instead. `-o` defaults to `<deck>.apkg` next to
  `deck.json`.

`check` and `review` resolve the Anki media directory the same way the two
Python originals do: the `ANKI_MEDIA` environment variable if set, otherwise
whichever of the two hardcoded per-profile paths exists on disk (the macOS
path is tried first regardless of host OS — a filesystem probe, not a
platform check). `export`'s `--media-dir` uses the same resolution when
omitted.

### The TS-to-test story

Test files live under `test/` as `.ts` and run directly — no `tsx`, no
`ts-node`, no test framework. Node 24 strips TypeScript syntax from a `.ts`
file with no flag needed, and `node --test "test/**/*.test.ts"` runs every
test file under that directory, so `npm test` is just that plus a build first.

**The glob is load-bearing, and it took two corrections to get right.** Bare
`node --test` matches any file whose name ends in `test.js` *anywhere*
beneath the repo, which swept in twelve files from the npm bundled into
`app/src-tauri/` build artifacts (`lib/commands/test.js`, `install-test.js`,
`install-ci-test.js`, once per staged copy) — each contributing nothing but a
passing tick. It also began matching `site/test/`, a separate npm project
whose suite needs its own installed dependencies.

Narrowing that to `test/**/*.ts` fixed both but was still too wide: it runs
every `.ts` under `test/`, not just test files, so thirteen helper modules,
fake servers and child-process entry points (`test/acp/mock-agent.ts`,
`test/sidecar/fake-openrouter.ts`, the `helpers.ts` files) each registered as
a passing test too. Requiring `.test.ts` is what makes the reported number
the number of tests: **323**, not the 330 that glob reported or the 342 bare
discovery did. Any of those entry points growing a blocking top-level side
effect would otherwise hang `npm test` for reasons unrelated to any test.

The site's own suite is `npm --prefix site test`. Note that `**` matches zero
directories, so `test/scaffold.test.ts` is included without a second pattern.

The one rule this depends on: **test files import runtime code from the
compiled `dist/`, never from `src/` directly.** Source files import each
other with `.js`-extensioned specifiers, per NodeNext module resolution, so
that `tsc` emits a `dist/` that runs standalone as plain JavaScript — that
compiled output is the actual product, not a side effect of testing.

Running a `src/*.ts` file raw, instead, hits those same `.js` specifiers
before there's any compiled `.js` for Node to find. Confirmed by hand: a
`.ts` file that imports a sibling via `./sibling.js` cannot be run directly
when only `sibling.ts` exists on disk — Node does not fall back from `.js` to
`.ts`, it throws `ERR_MODULE_NOT_FOUND`. Importing from `dist/` instead
sidesteps this entirely, because there the specifier and the on-disk file are
both genuinely `.js`.

Concretely, in a test file:

```ts
import { checkNote } from '../dist/checks/foo.js';  // runtime value: from dist
import type { Finding } from '../dist/types.js';    // type only: also from dist,
                                                      // resolved via dist/types.d.ts
```

Type-only imports need the `type` keyword. Node's stripping works one file at
a time with no cross-file knowledge of what's a type versus a value — an
import written without `type` is left as a real runtime import, and if the
name is actually type-only (as everything in `src/types.ts` is), that import
has no matching runtime export and throws at test time. Always write `import
type` for anything that's only ever a type.

Because tests resolve against `dist/` (gitignored, so a fresh clone starts
without it), both `npm test` and `npm run typecheck` build first — already
wired into both scripts, nothing extra to run by hand.

The one exception: a `.ts` helper that only other test files import (nothing
under `src/` needs it) can use an explicit `.ts` specifier instead —
`tsconfig.test.json` turns on `allowImportingTsExtensions` for exactly that
case, and it resolves fine at runtime because the specifier and the on-disk
file agree there too.

## Layout

- `src/types.ts` — the shared contract: the AnkiConnect-shaped note
  (`DeckNote`, `NoteFields`) and the structural-check result (`Finding`).
  Deliberately minimal — nothing module-specific lives here.
- `src/checks/` — port of the Python deck checker's structural checks.
- `src/apkg/` — `.apkg` writer.
- `src/acp/` — Agent Client Protocol client: JSON-RPC over stdio, session
  lifecycle, streamed prompt turns, cancellation, and permission requests
  routed through a caller-supplied policy. Tested against a mock agent only
  — no live agent handshake yet, see [Status](#status).
- `src/cli/` — the `ape` CLI: argv parsing and exit codes wired onto
  `src/checks` and `src/apkg` (see [CLI](#cli) above). Owns deck.json
  loading/validation (`deck-loader.ts`) and Anki-media-directory resolution
  (`media-dir.ts`) — neither `src/checks` nor `src/apkg` does this itself,
  since both treat `DeckNote[]` as already-validated input.
- `src/pipeline/` — the method as prompts and a runner: each stage hands the
  agent a method file and the course folder and asks for that stage's
  artifact; the auditor and adjudicator run in fresh sessions. Over an
  injected client, so the desktop app and the browser page run the same
  stages from the same file.
- `src/sidecar/` — the JSON-RPC surface the shells drive. `dispatch.ts` is
  the transport-neutral core (method table, reverse channel, ordering);
  `index.ts` speaks it over stdio for the desktop app, `serve.ts` over HTTP
  and Server-Sent Events on loopback for the browser page. `deck/export`
  loads `node:sqlite` lazily so everything else runs on Node 20.
- `src/bridge/` — `ape-bridge`: the sidecar as a local server, for the
  browser page. Prints a URL with a per-run token in the fragment, opens it,
  fetches the method files once, and binds 127.0.0.1 only. The one command
  a subscriber runs; needs Node ≥ 20, which Claude Code needs too.
- `app/` — the desktop app (Tauri), its own npm project; `docs/APP.md`.
  `src/agent/` is the shell — the rail, the picker, the chat, the eight
  stages, the gates, the permission policy — over the `EngineHost` seam in
  `src/engine/host.ts`, which `tauri-host.ts` implements for the app and
  the site's bridge transport implements for the page. `src/engine/pdf-extract.ts`
  reads PDFs in the webview so the agent never asks for tooling.
- `site/` — the website, its own npm project like `app/`. `/` is the
  download page; `/tool/` runs the engine in the tab (checks, review,
  `.apkg` export, nothing installed, nothing uploaded) and, when opened by
  `ape-bridge`, becomes the app's shell over the bridge. Carries sql.js and
  fflate so the engine keeps its zero-dependency rule.
- `test/integration/` — drives the built CLI as a real child process
  (never `checkDeck`/`renderReview`/`writeApkg` called directly) through
  the full check → review → export pipeline on the seven reference cards,
  then reopens the produced `.apkg` with the system `unzip` and
  `node:sqlite` — tools sharing no code with this repo. A second file
  covers CLI-boundary argument/exit-code behavior the golden path doesn't
  (usage errors, a dirty deck, a missing file, `--inventory`/`--transcript`
  wiring).
- `test/fixtures/reference-cards.json` — the seven canonical reference cards
  (`ref-01`..`ref-07`) that define the card style, copied verbatim from their
  source (see `docs/research/check-deck-contract.md` for exactly where and
  the full rationale). Any check or renderer this repo ships must pass all
  seven before its verdict is trusted: a check that rejects one of these, or
  accepts something one of these would reject, is what's wrong, not the
  fixture. `test/scaffold.test.ts` pins the fixture's exact text against that
  source so an edit can't silently drift it.
- `docs/research/` — implementer's-reference notes written before this code:
  the ACP v1 wire protocol, the `.apkg` file format, and the behavioral
  contracts of the two Python tools being ported. Read the one that matches
  before touching a given module.
- `docs/STATUS.md` — per-module: what works, what is stubbed, what the next
  concrete step is. The detail behind the summary below.

## Status

Everything claimed here was checked by actually running the command named,
not by reading the code and assuming — see `docs/STATUS.md` for the same
picture broken out per module.

**`src/checks` and `src/apkg` are solid.** Both have exhaustive suites:
`src/checks`' differential tests run the real `python3 tools/check_deck.py`
and `tools/render_review.py` in the engine repo and diff output
byte-for-byte; `src/apkg`'s tests reopen every `.apkg` they write with the
system `unzip` and `node:sqlite`, tools sharing no code with the writer
itself. All green.

**`src/cli` (this integration pass) works end-to-end against the reference
fixture.** `test/integration/pipeline.test.ts` spawns the real, built
`dist/cli/index.js` — never the underlying functions directly — through
`check` (clean) → `review` (writes real HTML) → `export` (writes a real
`.apkg`), then reopens that `.apkg` independently and checks its note count,
card count, deck name, notetype, and every field's round-tripped content.
`test/integration/cli-errors.test.ts` covers the CLI-boundary behavior the
golden path doesn't: usage errors, a missing file, malformed JSON, a note
missing `fields.Text`, a deck naming zero notes, a genuinely dirty note,
`--inventory`/`--transcript` wiring, and a `--deck-name` override. Also
exercised by hand beyond what's automated, including the media-directory
default-resolution fallback.

**What has not been verified, by anyone, at any point:**

- **Anki import: now verified** (this bullet previously said it was not).
  `test/apkg/anki-import.test.ts` imports an exported package into a
  disposable Anki 26.5 collection and asserts 7 notes / 14 cards with the
  expected cloze ordinals. It was written after that exact check found that
  every package this repo produced was rejected by Anki — see
  [docs/STATUS.md](docs/STATUS.md). It skips, loudly, where Anki is absent.
  **AnkiConnect sync is still unverified**, and no live tier is built.
- **Real agents: proven through the prompt turn.** Against
  `@agentclientprotocol/claude-agent-acp` 0.75.1, live: handshake, protocol
  negotiation, `session/new`, a completed turn (`end_turn`), streamed
  updates, real tool calls, and mid-turn cancellation (`cancelled`).
- **Permission requests work, once the mode is pinned.** An agent inherits
  its permission mode from the host's own config; in `auto` it decides for
  itself and never asks. `setMode('default')` pins Manual, and a real
  `session/request_permission` then routes to the caller's policy callback —
  verified live in both directions: denial blocked a file write, approval
  allowed it. Anything relying on this must call `setMode` explicitly rather
  than assume a default. An earlier version of this file said permission
  requests could not be treated as a safety boundary; that was true before
  `session/set_mode` existed and is no longer.
- **Sign-in is the agent CLI's job, not A.P.E.'s.** The Claude adapter
  returns `authMethods: []` and handles auth out-of-band, so ACP
  `authenticate` will not unblock Claude Code — log in with the `claude`
  CLI. Gemini CLI does advertise auth methods, which is where an
  `authenticate` implementation matters.
- **`npm test` used to lie here.** The script called bare `node`, and on
  Node 20 the test runner does not discover `.ts` files — it reported
  `0 tests, 0 fail` and exited 0. A `pretest` guard now refuses to run below
  Node 24 and explains why. If you see a suspiciously fast green, check
  `node --version` first.

Given a `deck.json` shaped like `test/fixtures/reference-cards.json`, a user
can check it, render a review page for it, and export an `.apkg` that real
Anki imports — all three verified by running them, the last against a
disposable Anki 26.5 collection. What they cannot yet do through this repo
is drive an actual ACP coding agent: `src/acp/` is empty, and the tests
waiting for it are red on purpose.
