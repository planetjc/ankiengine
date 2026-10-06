// Shared plumbing for test/apkg/*.test.ts.
//
// Nothing here decides what a *correct* .apkg looks like -- every expected
// value lives in the individual test files, hand-derived or independently
// computed against docs/research/apkg-format.md and, where possible, a real
// Anki-written .apkg found on this machine. This file only extracts and
// inspects writeApkg's output using tools that share no code with the
// exporter itself: the system `unzip` binary (a real, independent zip
// reader) and node:sqlite in readOnly mode.
//
// Only other test files import this (nothing under src/ needs it), so it
// uses an explicit .ts specifier -- tsconfig.test.json turns on
// allowImportingTsExtensions for exactly this case.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DeckNote } from '../../dist/types.js';

/**
 * A fixed "now" for every determinism-sensitive assertion in this suite.
 * Picking a constant instead of Date.now() is what makes exact equality
 * checks on col.mod/notes.mod/cards.mod possible at all -- see
 * docs/research/apkg-format.md §8: "seed a counter at Date.now()... when the
 * exporter starts". writeApkg's `clock` option is the injection point; the
 * implementation must derive every id/timestamp from clock()'s return value
 * and its own counter state, and every note guid from the note itself, never
 * from a fresh Date.now()/Math.random()/crypto.randomUUID() call, or
 * determinism.test.ts cannot pass no matter how the rest of the exporter is
 * written. (Guids once rode on the clock too; that made every re-export a
 * second copy of the deck in Anki -- notes.test.ts pins why they do not.)
 */
export const FIXED_CLOCK_MS = 1_700_000_000_000;
export const fixedClock = (): number => FIXED_CLOCK_MS;

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `ape-apkg-${prefix}-`));
}

/**
 * Creates and returns a real, empty media directory under `tempDir`, for
 * tests where no note references any media. Deliberately not "just pass a
 * path that doesn't exist" -- whether writeApkg should tolerate a missing
 * mediaDir when nothing needs it is exactly the kind of behavior the format
 * doc never specifies, and this suite should not bake in an untested
 * assumption either way. Every case that has no media fixture to copy in
 * still gets a real, empty, existing directory.
 */
export function makeEmptyMediaDir(tempDir: string): string {
  const dir = join(tempDir, 'media-src');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Builds a minimal valid DeckNote for tests that don't care about most of
 * its shape. `deckName` defaults to one shared deck; schema.test.ts's
 * col.decks tests give notes different ones.
 */
export function makeNote(
  text: string,
  overrides: Partial<{ extra: string; source: string; tags: string[]; deckName: string }> = {},
): DeckNote {
  return {
    deckName: overrides.deckName ?? 'Fixtures::Apkg Writer Tests',
    modelName: 'Custom Cloze',
    fields: {
      Text: text,
      Extra: overrides.extra ?? '',
      Source: overrides.source ?? 'Slide 1',
    },
    tags: overrides.tags ?? ['fixture'],
  };
}

export interface ZipEntry {
  name: string;
  length: number;
}

// Parses the plain `unzip -l` listing: a couple of header/dashed-separator
// lines, one row per entry ("<length>  <mm-dd-yyyy> <hh:mm>   <name>"), then
// a totals row. Row shape confirmed directly against a real .apkg on this
// machine before being relied on here (see the review notes returned
// alongside this suite) -- the totals row never matches because it has no
// date/time field, so it's naturally excluded rather than needing a
// separate skip rule.
export function listZipEntries(apkgPath: string): ZipEntry[] {
  const out = execFileSync('unzip', ['-l', apkgPath], { encoding: 'utf8' });
  const entries: ZipEntry[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}\s+(.+)$/.exec(line);
    if (m) entries.push({ length: Number(m[1]), name: m[2] });
  }
  return entries;
}

export interface ZipEntryDetail {
  name: string;
  method: string;
  crc32: string;
  length: number;
  compressedSize: number;
}

// Parses `unzip -v` (per-entry compression method and CRC-32), likewise
// confirmed against a real .apkg's actual output shape first.
export function listZipEntryDetails(apkgPath: string): ZipEntryDetail[] {
  const out = execFileSync('unzip', ['-v', apkgPath], { encoding: 'utf8' });
  const entries: ZipEntryDetail[] = [];
  const re = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+\d+%\s+\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}\s+([0-9a-fA-F]{8})\s+(.+)$/;
  for (const line of out.split('\n')) {
    const m = re.exec(line);
    if (m) {
      entries.push({
        length: Number(m[1]),
        method: m[2],
        compressedSize: Number(m[3]),
        crc32: m[4].toLowerCase(),
        name: m[5],
      });
    }
  }
  return entries;
}

// `unzip -t` exercises the real zip reader's own CRC-32 verification against
// every member, independent of whatever CRC the exporter thinks it wrote.
// execFileSync throws on a non-zero exit, i.e. on any integrity failure --
// callers just need this not to throw.
export function checkZipIntegrity(apkgPath: string): void {
  execFileSync('unzip', ['-t', apkgPath], { encoding: 'utf8' });
}

// Extracts one member to `destDir` (flat filenames only -- everything this
// project's .apkg ever contains) and returns its on-disk path.
export function extractZipMember(apkgPath: string, memberName: string, destDir: string): string {
  execFileSync('unzip', ['-o', '-q', apkgPath, memberName, '-d', destDir]);
  return join(destDir, memberName);
}

// Reads one member's decompressed bytes straight to a Buffer via `unzip -p`,
// without writing it to disk -- used for the small `media` manifest and for
// round-tripping embedded media file bytes.
export function readZipMember(apkgPath: string, memberName: string): Buffer {
  return execFileSync('unzip', ['-p', apkgPath, memberName]);
}

export function openCollection(anki21Path: string): DatabaseSync {
  return new DatabaseSync(anki21Path, { readOnly: true });
}
