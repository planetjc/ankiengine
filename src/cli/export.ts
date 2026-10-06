// `ape export` -- no Python original to port (the engine repo's pipeline
// hands off to AnkiConnect at this stage; writeApkg, src/apkg, is this
// project's own replacement for that step), so this file's argv shape is
// this task's own spec, not a contract-derived byte-for-byte match. It
// still reuses every convention the other two subcommands already
// established, for the same reason a user of the engine repo should
// recognize `check`/`review` at all: one shared media-dir resolution
// (media-dir.ts), one shared deck loader (deck-loader.ts), and a default
// output path in the same "sibling file next to deck.json" shape
// render_review.py uses for its own default.
import { basename, dirname, extname, join } from 'node:path';
import { writeApkg } from '../apkg/index.js';
import { loadDeckMedia } from './deck-loader.js';
import { requireOnePositional, takeSingle } from './args.js';
import { loadDeckNotes } from './deck-loader.js';
import { isExistingDirectory, resolveMediaDir } from './media-dir.js';

const USAGE = 'usage: ape export <deck.json> [-o <out.apkg>] [--deck-name <name>] [--media-dir <dir>]';

function defaultApkgPath(deckPath: string): string {
  const stem = basename(deckPath, extname(deckPath));
  return join(dirname(deckPath), `${stem}.apkg`);
}

export function runExport(argv: string[]): number {
  const args = [...argv];
  if (args.includes('-h') || args.includes('--help')) {
    console.log(USAGE);
    return 0;
  }

  const outOpt = takeSingle(args, '-o');
  const deckNameOpt = takeSingle(args, '--deck-name');
  const mediaDirOpt = takeSingle(args, '--media-dir');
  const deckPath = requireOnePositional(args, USAGE);
  const notes = loadDeckNotes(deckPath);

  const outPath = outOpt ?? defaultApkgPath(deckPath);
  // --deck-name puts every note into that one deck; without it each note
  // keeps its own deckName, so a multi-deck deck.json is one package.
  const mediaDir = mediaDirOpt ?? resolveMediaDir();

  if (mediaDirOpt === undefined && !isExistingDirectory(mediaDir)) {
    console.error(`note: ${mediaDir} not found - media references will be packaged unresolved`);
  }

  const { unresolvedMedia } = writeApkg(notes, { deckName: deckNameOpt, outPath, mediaDir, media: loadDeckMedia(deckPath), fallbackDirs: [dirname(deckPath)] });
  console.log(`wrote ${outPath} (${notes.length} notes)`);
  if (unresolvedMedia.length > 0) {
    console.error(`media not found in ${mediaDir}, packaged without: ${unresolvedMedia.join(', ')}`);
  }
  return 0;
}
