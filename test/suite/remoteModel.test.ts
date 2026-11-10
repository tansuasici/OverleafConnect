import * as assert from 'assert';
import { authorsOf, decodeRevQuery, mergeUpdates, encodeRevQuery, revDiffTitle, summarizeRemoteUpdate, RemoteUpdate } from '../../src/sync/remoteModel';

const commit = (author: string) => ({ hash: 'a'.repeat(40), author, message: 'Update', date: new Date(0) });
const update = (files: string[], authors: string[]): RemoteUpdate => ({ base: 'b1', head: 'h1', files, commits: authors.map(commit) });

suite('remoteModel', () => {
  test('names a single file and its author', () => {
    assert.strictEqual(summarizeRemoteUpdate(update(['chapters/intro.tex'], ['Ayşe'])), 'intro.tex was updated on Overleaf by Ayşe.');
  });

  test('counts files and folds many authors', () => {
    assert.strictEqual(summarizeRemoteUpdate(update(['a.tex', 'b.bib'], ['Ayşe', 'Mehmet', 'Ayşe'])), '2 files were updated on Overleaf by Ayşe and Mehmet.');
    assert.strictEqual(summarizeRemoteUpdate(update(['a.tex', 'b.tex', 'c.tex'], ['A', 'B', 'C'])), '3 files were updated on Overleaf by A and 2 others.');
  });

  test('says nothing when no file changed, and leaves out a missing author', () => {
    assert.strictEqual(summarizeRemoteUpdate(update([], ['Ayşe'])), undefined);
    assert.strictEqual(summarizeRemoteUpdate(update(['a.tex'], [''])), 'a.tex was updated on Overleaf.');
  });

  test('keeps authors in first-seen order without duplicates', () => {
    assert.deepStrictEqual(authorsOf(['B', 'A', 'B'].map(commit)), ['B', 'A']);
  });

  test('round-trips the revision query and rejects anything but a hash', () => {
    const folder = '/Users/a b/Tez & Notlar';
    assert.deepStrictEqual(decodeRevQuery(encodeRevQuery(folder, 'abc1234')), { folderPath: folder, ref: 'abc1234' });
    assert.strictEqual(decodeRevQuery(encodeRevQuery(folder, 'HEAD; rm -rf')), undefined);
    assert.strictEqual(decodeRevQuery('ref=abc1234'), undefined);
  });

  test('joins two pulls from the first base to the newest head', () => {
    const merged = mergeUpdates({ ...update(['a.tex'], ['A']), base: 'b1', head: 'h1' }, { ...update(['a.tex', 'b.tex'], ['B']), base: 'h1', head: 'h2' });
    assert.strictEqual(merged.base, 'b1');
    assert.strictEqual(merged.head, 'h2');
    assert.deepStrictEqual(merged.files, ['a.tex', 'b.tex']);
    assert.deepStrictEqual(authorsOf(merged.commits), ['B', 'A']);
  });

  test('titles mark new and deleted files', () => {
    assert.strictEqual(revDiffTitle('a/main.tex', true, true), 'main.tex — before ↔ Overleaf');
    assert.strictEqual(revDiffTitle('fig.png', false, true), 'fig.png — before ↔ Overleaf (new)');
    assert.strictEqual(revDiffTitle('old.tex', true, false), 'old.tex — before ↔ Overleaf (deleted)');
  });
});
