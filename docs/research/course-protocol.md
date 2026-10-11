# Sidecar protocol, part 3: method files and the course folder

Extends `sidecar-protocol.md` (framing, lifecycle, errors unchanged). These
are read-only file methods so the app can build a stage's prompt without the
webview touching the filesystem. Nothing here interprets content.

## 1. Method files

The bundled method files live in the directory named by env `APE_METHOD_DIR`
(set by the app: the `method/` resource in a bundle, the method repo's
`method/` in dev). Missing or unreadable → `-32000` `"APE_METHOD_DIR is not
set or not a directory"` on either method.

### `method/list`
params none → `{ dir: string, files: [{ name, title, bytes }] }` — every
`*.md` directly in the directory, sorted by name. `title` is the text of
the first line starting `# `, else YAML frontmatter `name:` if the file
starts with `---`, else the file name without `.md`.

### `method/read`
params `{ name }` → `{ name, text }`. `name` must be a bare file name that
`method/list` would return (no `/`, no `..`); otherwise `-32602` naming
`name`. A name not present → `-32602`.

## 2. The course folder

### `course/list`
params `{ path }` (a directory) →
```
{ path, files: File[], artifacts: { inventory: boolean, plan: boolean, deck: boolean, flags: boolean, review: boolean }, extracted: Extracted[] }
```
`File` is `{ name, relPath, bytes, kind, mimeType }` for every regular
file under `path`, recursive, sorted by `relPath`, skipping entries whose
name starts with `.`, `node_modules`, the top-level `_extracted/` tree, and
the artifacts themselves (`inventory.md`, `plan.md`, `deck.json`,
`flags.json`, `review.html`, `audit.md`, `audit.json`, `verdicts.md`,
`*.apkg`). `kind` by extension: `pdf`; `image` (png jpg jpeg gif webp);
`audio` (mp3 m4a wav aac ogg flac); `video` (mp4 mov webm mkv); `text` (md
txt vtt srt csv json html); `slides` (pptx ppt key odp); `doc` (docx doc
pages rtf); else `other`. `mimeType` is the usual one for the extension,
`application/octet-stream` when unknown. `artifacts` reports which of
`inventory.md`, `plan.md`, `deck.json`, `flags.json`, `review.html` exist
directly in `path`. A `path` that is not a directory → `-32000`.

`extracted` is what the page put beside a source file under
`_extracted/<relPath of the source>/`: for each listed file whose directory
there exists, `{ source, text, images }` — `source` the file's `relPath`,
`text` the relPath of `text.md` when present (else `null`), `images` the
relPaths of `pNNN.png|jpg|jpeg|webp` sorted by name. In `files` order; a
directory for nothing listed, or with neither text nor images, is omitted.

### `course/read`
params `{ path, name, encoding? }` → `{ name, text, bytes }` — reads a UTF-8
text file whose `name` is relative to `path`, refused (`-32602`) if it
escapes `path` or is not a regular file; only for files whose `kind` would
be `text` (else `-32602` `"…is not a text file"`). Binary attachments do not
pass through this on their way to the agent: the app hands them over as
`resource_link` blocks, and the agent (or the embedded loop) reads them
itself.

With `encoding: "base64"` → `{ name, base64, bytes }`: the file's bytes, any
kind, same confinement. This is how the desktop app's webview gets a PDF to
its own reader (it reaches the filesystem only through the sidecar); the
bridge serves the same bytes over `/file`. Any other `encoding` → `-32602`.

### `course/write`
params `{ path, name, text }` or `{ path, name, base64 }` → `{ name, bytes }`
— writes one file at `name` relative to `path`, creating directories,
replacing what is there. Exactly one of `text` (UTF-8) or `base64` (bytes),
else `-32602`; `name` that is `path` itself, escapes it, or names a
directory → `-32602` naming `name`; `path` not a directory → `-32000`. The
page uses it for `_extracted/…` (text and page images from a PDF, rendered
in the tab); nothing else writes through it today.

### `course/import`
params `{ path, files }` → `{ imported }` — copies each absolute path in
`files` into `path` by its basename (a directory: its regular files one
level deep, dotfiles skipped, the directory not recreated). A missing
source → `-32602`. How the desktop shell takes a drop or a picker's
choice; the page, which has bytes rather than paths, uses `course/write`.

### `course/delete`
params `{ path, name }` → `{ name, removed }` — removes one file beneath
`path`, and `_extracted/<name>/` with it; `removed: false` when it was not
there. Confined like `course/read`; a directory → `-32602`.

### `decks/list`, `decks/create`
The shell's own workspaces: one course folder per deck under a `root` it
names (the data dir's `decks/`). `decks/list { root }` → `{ root, decks }`,
each `{ name, path, files, pdfs, artifacts, modified }`, newest first; the
root is created if absent. `decks/create { root, name }` → `{ name, path }`
with the folder name derived from the deck name (separators and characters
a filesystem refuses become `-`; `Anatomy::Lecture 3` → `Anatomy-Lecture 3`)
and numbered on a clash.

## 2b. Anki, through AnkiConnect (added 2026-09-11)

The method's own insertion route is the AnkiConnect add-on's JSON endpoint
on `localhost:8765` (3-cards.md, "Getting the notes in"); the sidecar
speaks to it directly (`src/sidecar/anki.ts`), so the app needs neither an
agent nor the MCP server to put a deck into Anki. Env `APE_ANKI_CONNECT`
overrides the URL (tests point it at `test/sidecar/fake-anki.ts`).

### `anki/status`
params none → `{ url, reachable, version, error }`. `reachable: false`
carries the sentence the app shows: "Anki is not open, or the AnkiConnect
add-on (code 2055492159) is not installed. Open Anki and try again."

### `anki/send`
params `{ path, deckName? }` → `{ decks, total, added, skipped, media,
unresolvedMedia, createdModel }`. In order: `version` (unreachable →
`-32000` with the sentence above), `modelNames` and `createModel` for
`Custom Cloze` only when the collection lacks it (the same fields,
templates and CSS the .apkg exporter writes), `createDeck` for every
distinct deck name (`deckName` overrides every note's own), `storeMediaFile`
for every image a field references, resolved through the deck's own media
list then the Anki media directory then the deck's folder (a name found
nowhere is listed in `unresolvedMedia` and the send goes on), then one
`addNotes` with `allowDuplicate: false, duplicateScope: "deck"` — a `null`
id counts as `skipped`. An AnkiConnect error string → `-32000`
`"AnkiConnect: <error>"`.

### Anki read back (added 2026-10-11)

Four reads, none of which changes the collection: they call only
`deckNames`, `modelNames`, `findNotes`, `findCards`, `notesInfo` and
`canAddNotes` (which builds each note in memory and adds nothing). Not
`getDeckStats`: it looks a deck up with `decks.id()`, which creates a
missing deck. Each answers `{ reachable, error, … }` as `anki/status` does:
Anki closed is `reachable: false` with the sentence above and the rest
empty, never a JSON-RPC error. A missing required param is `-32602`.

A deck is searched as `deck:"<name>"` with `\`, `"`, `*` and `_` escaped by
a backslash — the last two are wildcards in Anki's search, so "A_B"
unescaped also finds "AxB" — which is the deck and every subdeck beneath it,
any case. Checked against Anki 26.5's own search on a scratch collection;
`test/sidecar/fake-anki.ts` parses queries the same way.

- `anki/decks` params none → `{ reachable, error, decks }`: every deck name,
  `::` and all, in Anki's order.
- `anki/deckStats` params `{ deck }` → `{ reachable, error, deck, exists,
  notes, cards, new, learning, review }` for the deck and its subdecks.
  `new` is `is:new` (never studied, buried or suspended ones too), `review`
  is `is:review` (graduated, relearning included), `learning` the rest, so
  the three add up to `cards`. A deck Anki lacks is `exists: false` and
  zeros, and is not made.
- `anki/existing` params `{ path, deckName? }` → `{ reachable, error, decks,
  total, existing, inAnki }`: which of the deck.json's notes Anki already
  holds by the rule `anki/send` skips them by (`canAddNotes`, duplicate
  scope "deck"). A note whose deck or note type Anki lacks, or whose first
  field is empty, is not asked about — canAddNotes would refuse it for
  that, which is not "already there". `inAnki` is per note, in order.
- `anki/deckNotes` params `{ deck, limit? }` (default 200) → `{ reachable,
  error, deck, exists, total, firstFields }`: the first field of each note
  in the deck and its subdecks, oldest first, up to `limit`; `total` counts
  them all. With `anki/deckStats`'s counts, this is what the organize and
  cards steps are told the deck already holds (src/pipeline/anki.ts, read
  through `StageOptions.anki`); a step waits on Anki 5 s at most.

## 3. What the oracle must prove

- `method/list`/`read` against a temp dir with three `.md` files (one with
  a `# ` title, one with frontmatter `name:`, one with neither), sorted;
  `read` returns exact text; `../x.md`, `a/b.md`, unknown name → `-32602`;
  unset `APE_METHOD_DIR` → `-32000`.
- `course/list` against a temp tree with nested files of several kinds, a
  dotfile, a `node_modules` dir, and the artifacts present/absent; exact
  `files` and `artifacts`; a file path instead of a dir → `-32000`.
- `course/read` for `notes.md` (exact text), for a nested `sub/a.txt`, for
  `../outside.md` → `-32602`, for `slide.png` → `-32602`.
- `course/write` text and base64 into `_extracted/lecture.pdf/`, bytes
  round-tripping exactly; then `course/list` reports the entry (images
  sorted, `text` null until written) and still lists the same `files`; a
  nested source keeps its path; an extracted dir for nothing listed is
  ignored; overwrite allowed. Refused: `../outside.md`, an absolute name,
  `.`, a directory, both bodies, neither body, missing params, a file for
  `path` — and nothing outside is touched by a refused call.
