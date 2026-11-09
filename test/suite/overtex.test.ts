import * as assert from 'assert';
import {
  BuildSyncGate,
  chooseLatexBackend,
  LATEX_WORKSHOP_ID,
  OVERTEX_ID,
  PausableSync,
} from '../../src/latex/overtex';

function fakeSync(paused = false): PausableSync & { paused: boolean; synced: number } {
  return {
    paused,
    synced: 0,
    pause() {
      this.paused = true;
    },
    resume() {
      this.paused = false;
    },
    async syncNow() {
      if (!this.paused) {
        this.synced++;
      }
    },
  };
}

suite('Overtex handoff', () => {
  suite('chooseLatexBackend', () => {
    const installed = (...ids: string[]) => (id: string) => ids.includes(id);

    test('uses the built-in compiler when neither is installed', () => {
      assert.strictEqual(chooseLatexBackend(installed()), 'builtin');
    });

    test('defers to LaTeX Workshop alone', () => {
      assert.strictEqual(chooseLatexBackend(installed(LATEX_WORKSHOP_ID)), 'latex-workshop');
    });

    test('prefers Overtex when both are installed', () => {
      assert.strictEqual(chooseLatexBackend(installed(LATEX_WORKSHOP_ID, OVERTEX_ID)), 'overtex');
    });
  });

  suite('BuildSyncGate', () => {
    test('pauses during a build, then resumes and syncs', async () => {
      const sync = fakeSync();
      const gate = new BuildSyncGate(() => sync);

      gate.buildStarted();
      assert.strictEqual(sync.paused, true);

      await gate.buildEnded();
      assert.strictEqual(sync.paused, false);
      assert.strictEqual(sync.synced, 1);
    });

    test('stays paused until overlapping builds have all ended', async () => {
      const sync = fakeSync();
      const gate = new BuildSyncGate(() => sync);

      gate.buildStarted();
      gate.buildStarted();
      await gate.buildEnded();
      assert.strictEqual(sync.paused, true);
      assert.strictEqual(sync.synced, 0);

      await gate.buildEnded();
      assert.strictEqual(sync.paused, false);
      assert.strictEqual(sync.synced, 1);
    });

    test('leaves a pause the user set before the build', async () => {
      const sync = fakeSync(true);
      const gate = new BuildSyncGate(() => sync);

      gate.buildStarted();
      await gate.buildEnded();

      assert.strictEqual(sync.paused, true);
      assert.strictEqual(sync.synced, 0);
    });

    test('leaves a pause the user set during the build', async () => {
      const sync = fakeSync();
      const gate = new BuildSyncGate(() => sync);

      gate.buildStarted();
      gate.release();
      sync.pause();
      await gate.buildEnded();

      assert.strictEqual(sync.paused, true);
      assert.strictEqual(sync.synced, 0);
    });

    test('does nothing when no sync is configured', async () => {
      const gate = new BuildSyncGate(() => undefined);

      gate.buildStarted();
      await gate.buildEnded();
    });
  });
});
