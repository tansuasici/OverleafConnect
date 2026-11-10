import * as assert from 'assert';
import { conflictTitle, decodeConflictQuery, encodeConflictQuery, hasConflictMarkers, stageOf } from '../../src/sync/conflictModel';

suite('conflictModel', () => {
  test('maps sides to index stages', () => {
    assert.strictEqual(stageOf('ours'), 2);
    assert.strictEqual(stageOf('theirs'), 3);
  });

  test('round-trips folder and side through the query, including odd characters', () => {
    const folder = '/Users/a b/Tez & Notlar/proje?=1';
    assert.deepStrictEqual(decodeConflictQuery(encodeConflictQuery(folder, 'theirs')), { folderPath: folder, side: 'theirs' });
  });

  test('rejects a query without a folder or with an unknown side', () => {
    assert.strictEqual(decodeConflictQuery('side=ours'), undefined);
    assert.strictEqual(decodeConflictQuery('folder=%2Fx&side=base'), undefined);
  });

  test('finds conflict markers only as whole conflict blocks', () => {
    assert.ok(hasConflictMarkers('a\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> 480e26a\nb\n'));
    assert.ok(!hasConflictMarkers('a\nmine\nb\n'));
    assert.ok(!hasConflictMarkers('% a comment with <<<<<<< inside\n'));
    assert.ok(!hasConflictMarkers('=======\n'));
  });

  test('titles name the file and any deleted side', () => {
    assert.strictEqual(conflictTitle('chapters/intro.tex', true, true), 'intro.tex — Overleaf ↔ Yours');
    assert.strictEqual(conflictTitle('a.tex', false, true), 'a.tex — Overleaf ↔ Yours (deleted on Overleaf)');
    assert.strictEqual(conflictTitle('a.tex', true, false), 'a.tex — Overleaf ↔ Yours (deleted locally)');
  });
});
