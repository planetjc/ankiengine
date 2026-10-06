// CLI-boundary behavior the golden path in pipeline.test.ts never touches,
// because it is deliberately clean end to end: argv mistakes, a genuinely
// dirty deck, and the load-time failure modes check-deck-contract.md §1.5/
// §1.6 enumerate. checkDeck/checkNote's own opinion of a "dirty" note is
// already exhaustively covered by test/checks; what's tested here is only
// that src/cli reports the right exit code and stream for each case.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeReferenceCardsWorkDir, runCli } from './helpers.ts';

function makeWorkDir(): string {
  return mkdtempSync(join(tmpdir(), 'ape-cli-errors-'));
}

test('ape with no arguments: usage to stderr, exit 2', () => {
  const dir = makeWorkDir();
  const result = runCli([], { cwd: dir });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^usage: ape <command>/m);
  assert.equal(result.stdout, '');
});

test('ape --help: usage to stdout, exit 0', () => {
  const dir = makeWorkDir();
  const result = runCli(['--help'], { cwd: dir });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^usage: ape <command>/m);
});

test('ape with an unknown command: exit 2', () => {
  const dir = makeWorkDir();
  const result = runCli(['frobnicate'], { cwd: dir });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command: frobnicate/);
});

test('ape check with no deck.json argument: usage error, exit 2', () => {
  const dir = makeWorkDir();
  const result = runCli(['check', '--no-media'], { cwd: dir });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^usage: ape check /);
});

test('ape check on a missing file: exit 1, "cannot read"', () => {
  const dir = makeWorkDir();
  const missing = join(dir, 'nope.json');
  const result = runCli(['check', missing, '--no-media'], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`^cannot read ${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`));
});

test('ape check on malformed JSON: exit 1, "not valid JSON"', () => {
  const dir = makeWorkDir();
  const badJson = join(dir, 'bad.json');
  writeFileSync(badJson, '{not json');
  const result = runCli(['check', badJson, '--no-media'], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not valid JSON/);
});

test('ape check on a note missing fields.Text: exit 1, names the note position', () => {
  const dir = makeWorkDir();
  const badNote = join(dir, 'no-text.json');
  writeFileSync(badNote, JSON.stringify({ notes: [{ deckName: 'D', modelName: 'Custom Cloze', fields: { Extra: '' }, tags: [] }] }));
  const result = runCli(['check', badNote, '--no-media'], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /note 1 has no fields\.Text/);
});

test('ape check on an empty note list: "contains no notes", exit 2 (distinct from every other load failure)', () => {
  const dir = makeWorkDir();
  const emptyDeck = join(dir, 'empty.json');
  writeFileSync(emptyDeck, '[]');
  const result = runCli(['check', emptyDeck, '--no-media'], { cwd: dir });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /contains no notes/);
});

test('ape check on a genuinely dirty note: PROBLEMS on stdout, exit 1', () => {
  const dir = makeWorkDir();
  const dirtyDeck = join(dir, 'dirty.json');
  writeFileSync(
    dirtyDeck,
    JSON.stringify({
      notes: [{ deckName: 'D', modelName: 'Custom Cloze', fields: { Text: 'no cloze anywhere in this note', Extra: '', Source: 'x' }, tags: [] }],
    }),
  );
  const result = runCli(['check', dirtyDeck, '--no-media'], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^PROBLEMS:$/m);
  assert.match(result.stdout, /note 1: no cloze at all/);
});

test('ape check --no-media suppresses the missing-media-dir note; without it, the note appears on stderr and the run still exits 0 clean', () => {
  const { dir, deckPath } = makeReferenceCardsWorkDir();
  // This machine has a real, populated Anki profile under the real $HOME
  // (verified by hand while writing this suite), so exercising media-
  // dir.ts's "no ANKI_MEDIA, and the default profile path is also missing"
  // fallback needs its own empty $HOME -- merely deleting ANKI_MEDIA is not
  // enough to make the default resolve to something absent.
  const emptyHome = mkdtempSync(join(tmpdir(), 'ape-empty-home-'));

  const withFlag = runCli(['check', deckPath, '--no-media'], { cwd: dir, home: emptyHome });
  assert.equal(withFlag.status, 0);
  assert.equal(withFlag.stderr, '', 'no media-dir note when --no-media was passed explicitly');

  const withoutFlag = runCli(['check', deckPath], { cwd: dir, home: emptyHome });
  assert.equal(withoutFlag.status, 0, 'media dir missing only skips rule 2, it does not fail the run');
  assert.match(withoutFlag.stderr, /^note: .+ not found - skipping the media check$/m);
});

test('ape export keeps each note\'s own deckName and defaults -o to a sibling .apkg', () => {
  const { dir, deckPath, mediaDir } = makeReferenceCardsWorkDir();
  const result = runCli(['export', deckPath], { cwd: dir, mediaDir });
  assert.equal(result.status, 0, `export should exit 0; stderr was:\n${result.stderr}`);
  assert.equal(result.stdout.trim(), `wrote ${join(dir, 'deck.apkg')} (7 notes)`);
});

test('ape export --deck-name that differs from the notes\' own puts them all into it', () => {
  const { dir, deckPath, mediaDir } = makeReferenceCardsWorkDir();
  const outPath = join(dir, 'out.apkg');
  const result = runCli(['export', deckPath, '-o', outPath, '--deck-name', 'Some::Other::Deck'], { cwd: dir, mediaDir });
  assert.equal(result.status, 0, `export should exit 0; stderr was:\n${result.stderr}`);
  assert.equal(result.stdout.trim(), `wrote ${outPath} (7 notes)`);
});

test('ape check --inventory with no cited fact:: tags: rule 5a fires for every note', () => {
  const { dir, deckPath, mediaDir } = makeReferenceCardsWorkDir();
  const inventoryPath = join(dir, 'inventory.md');
  writeFileSync(inventoryPath, '| 1 | osteoid | unmineralized | bone | matrix | secreted |\n');
  const result = runCli(['check', deckPath, '--inventory', inventoryPath], { cwd: dir, mediaDir });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /carries no fact:: tag/);
});

test('ape check --inventory pointing at a file with no qualifying rows: exit 1', () => {
  const { dir, deckPath, mediaDir } = makeReferenceCardsWorkDir();
  const inventoryPath = join(dir, 'empty-inventory.md');
  writeFileSync(inventoryPath, 'not a fact row\n');
  const result = runCli(['check', deckPath, '--inventory', inventoryPath], { cwd: dir, mediaDir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no numbered fact rows found/);
});
