// What the conflict diff needs that does not depend on vscode, so it is tested with plain mocha.

/** URI scheme of the read-only documents that hold each side of a conflicted file. */
export const CONFLICT_SCHEME = 'overleafconnect-conflict';

/** "ours" is the local version (index stage 2), "theirs" is Overleaf's (stage 3). */
export type ConflictSide = 'ours' | 'theirs';

export function stageOf(side: ConflictSide): 2 | 3 {
  return side === 'ours' ? 2 : 3;
}

/** The URI query naming the folder and side; the relative path goes in the URI path so the diff keeps the file's language. */
export function encodeConflictQuery(folderPath: string, side: ConflictSide): string {
  return new URLSearchParams({ folder: folderPath, side }).toString();
}

export function decodeConflictQuery(query: string): { folderPath: string; side: ConflictSide } | undefined {
  const params = new URLSearchParams(query);
  const folderPath = params.get('folder');
  const side = params.get('side');
  if (!folderPath || (side !== 'ours' && side !== 'theirs')) {
    return undefined;
  }
  return { folderPath, side };
}

/** True while the text still has a conflict block git wrote into it. */
export function hasConflictMarkers(text: string): boolean {
  return /^<{7}(?: |$)/m.test(text) && /^>{7}(?: |$)/m.test(text);
}

/** The diff editor's title: Overleaf's version on the left, yours on the right. */
export function conflictTitle(relativePath: string, onOverleaf: boolean, local: boolean): string {
  const name = relativePath.split('/').pop() || relativePath;
  const notes = [!onOverleaf && 'deleted on Overleaf', !local && 'deleted locally'].filter(Boolean);
  return `${name} — Overleaf ↔ Yours${notes.length ? ` (${notes.join(', ')})` : ''}`;
}
