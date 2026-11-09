import type * as vscode from 'vscode';

export const OVERTEX_ID = 'tansuasici.overtex';
export const LATEX_WORKSHOP_ID = 'James-Yu.latex-workshop';

export type LatexBackend = 'overtex' | 'latex-workshop' | 'builtin';

/** Overtex wins over LaTeX Workshop: it warns about a double build with LaTeX Workshop itself. */
export function chooseLatexBackend(isInstalled: (id: string) => boolean): LatexBackend {
  if (isInstalled(OVERTEX_ID)) {
    return 'overtex';
  }
  return isInstalled(LATEX_WORKSHOP_ID) ? 'latex-workshop' : 'builtin';
}

/** Files Overtex leaves in the project that the default exclude patterns do not cover. */
export const OVERTEX_SYNC_EXCLUDES = ['*-arxiv.zip', 'overtex-diff-*/', '*.bcf', '*.run.xml', '*.xdv'];

/** The part of Overtex's public API (`activate()`'s return value) used here. */
export interface OvertexBuildEvents {
  readonly onDidStartBuild: vscode.Event<unknown>;
  readonly onDidEndBuild: vscode.Event<unknown>;
}

export interface PausableSync {
  readonly paused: boolean;
  pause(): void;
  resume(): void;
  syncNow(): Promise<void>;
}

/**
 * Holds sync back while Overtex builds, so a pull does not change sources mid-build,
 * then syncs what the wait skipped. A pause the user set stays in place: Overtex builds
 * on every save, so resuming unconditionally would undo it at the next save.
 */
export class BuildSyncGate {
  private activeBuilds = 0;
  private pausedByGate = false;

  constructor(private readonly getSync: () => PausableSync | undefined) {}

  buildStarted(): void {
    this.activeBuilds++;
    const sync = this.getSync();
    if (sync && !sync.paused) {
      sync.pause();
      this.pausedByGate = true;
    }
  }

  async buildEnded(): Promise<void> {
    this.activeBuilds = Math.max(0, this.activeBuilds - 1);
    if (this.activeBuilds > 0 || !this.pausedByGate) {
      return;
    }
    this.pausedByGate = false;
    const sync = this.getSync();
    sync?.resume();
    await sync?.syncNow();
  }

  /** The user paused or resumed by hand during a build; their choice stands when it ends. */
  release(): void {
    this.pausedByGate = false;
  }
}
