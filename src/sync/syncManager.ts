import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GitEngine } from './gitEngine';
import { FileWatcher } from './fileWatcher';
import { ConflictHandler } from './conflictHandler';
import { ConflictSide, hasConflictMarkers } from './conflictModel';
import { RemoteUpdate } from './remoteModel';
import { SyncState, ExtensionConfig } from '../types';
import { pendingFromStatus, RemoteCommit, SyncSnapshot } from '../ui/syncModel';
import { Logger } from '../utils/logger';

export class SyncManager implements vscode.Disposable {
  private timer: NodeJS.Timeout | null = null;
  private state: SyncState = SyncState.Idle;
  private isSyncing = false;
  private isPaused = false;
  private consecutiveFailures = 0;

  private readonly MAX_RETRY_DELAY = 60000;
  private readonly logger = new Logger('Overleaf Connect Sync');
  private readonly conflictHandler: ConflictHandler;

  private readonly _onStateChange = new vscode.EventEmitter<SyncState>();
  public readonly onDidChangeState = this._onStateChange.event;

  private lastSyncAt: Date | undefined;
  private lastError: string | undefined;
  private pendingFiles: string[] = [];
  private conflictedFiles: string[] = [];
  private recentRemoteCommits: RemoteCommit[] = [];
  private readonly _onSnapshotChange = new vscode.EventEmitter<SyncSnapshot>();
  /** Fires after each sync and whenever local files change between syncs. */
  public readonly onDidChangeSnapshot = this._onSnapshotChange.event;
  private readonly watcherListener: vscode.Disposable;
  private readonly _onRemoteUpdate = new vscode.EventEmitter<RemoteUpdate>();
  /** Fires after a sync brought in Overleaf's changes to at least one file. */
  public readonly onDidReceiveRemoteUpdate = this._onRemoteUpdate.event;

  constructor(
    private gitEngine: GitEngine,
    private fileWatcher: FileWatcher,
    private config: ExtensionConfig,
    private readonly projectUrl = ''
  ) {
    this.conflictHandler = new ConflictHandler(gitEngine, () => this.abortMerge());
    this.watcherListener = fileWatcher.onDidChangeDirty(() => {
      if (!this.isSyncing) {
        void this.refreshSnapshot();
      }
    });
  }

  get snapshot(): SyncSnapshot {
    return {
      state: this.state,
      projectUrl: this.projectUrl,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      pendingFiles: this.pendingFiles,
      conflictedFiles: this.conflictedFiles,
      recentRemoteCommits: this.recentRemoteCommits,
    };
  }

  /** Re-reads pending and conflicted files and the newest Overleaf commits from git. */
  async refreshSnapshot(): Promise<void> {
    try {
      const status = await this.gitEngine.statusAllFiles();
      const unpushed = await this.gitEngine.unpushedFiles();
      this.pendingFiles = pendingFromStatus([...status.files, ...unpushed.map((path) => ({ path }))]);
      const unmerged = await this.gitEngine.unmergedFiles();
      this.conflictedFiles = pendingFromStatus([...status.conflicted, ...unmerged].map((path) => ({ path })));
      this.recentRemoteCommits = await this.gitEngine.remoteLog(5);
    } catch {
      // Not a repository any more, or git is busy: keep what was shown.
    }
    this._onSnapshotChange.fire(this.snapshot);
  }

  start(): void {
    // A merge waiting on the user restarts auto-sync itself once it is finished.
    if (this.timer || this.state === SyncState.Conflict) {
      return;
    }
    const intervalMs = this.config.sync.intervalSeconds * 1000;
    this.timer = setInterval(() => this.syncCycle(), intervalMs);
    this.logger.info(`Auto-sync started (every ${this.config.sync.intervalSeconds}s)`);
    if (!this.isPaused) {
      this.setState(SyncState.Idle);
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info('Auto-sync stopped');
  }

  get paused(): boolean {
    return this.isPaused;
  }

  pause(): void {
    this.isPaused = true;
    this.logger.info('Auto-sync paused');
    if (this.state !== SyncState.Conflict) {
      this.setState(SyncState.Disabled);
    }
  }

  resume(): void {
    this.isPaused = false;
    this.logger.info('Auto-sync resumed');
    if (this.state === SyncState.Disabled) {
      this.setState(SyncState.Idle);
    }
    // The timer may have been stopped by a conflict that ended while paused (e.g. Abort Merge).
    this.restartAutoSync();
  }

  async syncNow(): Promise<void> {
    if (this.state === SyncState.Conflict) {
      await this.continueMerge();
    } else {
      await this.syncCycle();
    }
  }

  /** Enters the conflict state if a merge is waiting, e.g. after a reload in the middle of one. */
  async detectConflict(): Promise<boolean> {
    if (this.state !== SyncState.Conflict && (await this.gitEngine.isMerging())) {
      this.enterConflict(await this.gitEngine.unmergedFiles().catch(() => []));
      await this.refreshSnapshot();
      return true;
    }
    return this.state === SyncState.Conflict;
  }

  /** A file at one commit, or undefined when it did not exist there. */
  revisionContent(ref: string, relativePath: string): Promise<string | undefined> {
    return this.gitEngine.showAt(ref, relativePath);
  }

  /** The files one Overleaf commit changed, for the panel's commit rows. */
  commitUpdate(hash: string): Promise<RemoteUpdate | undefined> {
    return this.gitEngine.commitUpdate(hash);
  }

  private announce(update: RemoteUpdate | undefined): void {
    if (update?.files.length) {
      this._onRemoteUpdate.fire(update);
    }
  }

  /** One side of a conflicted file, or undefined when that side deleted it. */
  conflictVersion(relativePath: string, side: ConflictSide): Promise<string | undefined> {
    return this.gitEngine.showStage(side, relativePath);
  }

  /** Resolves a file with your version ("ours") or Overleaf's ("theirs"); finishes the merge after the last one. */
  async resolveConflict(relativePath: string, side: ConflictSide): Promise<void> {
    await this.conflictStep(() => this.gitEngine.resolveWith(side, relativePath));
  }

  /** Takes the file as edited by hand as the resolution, refusing while conflict markers remain. */
  async markResolved(relativePath: string): Promise<void> {
    const file = path.join(this.gitEngine.getWorkspacePath(), relativePath);
    if (fs.existsSync(file) && hasConflictMarkers(await fs.promises.readFile(file, 'utf8'))) {
      throw new Error(`${relativePath} still has conflict markers (<<<<<<< … >>>>>>>). Remove them, save, and try again.`);
    }
    await this.conflictStep(() => this.gitEngine.markResolved(relativePath));
  }

  /** Undoes the merge. Sync is paused afterwards, since the next one would hit the same conflict. */
  async abortMerge(): Promise<void> {
    if (this.isSyncing) {
      throw new Error('A sync is running; try again in a moment.');
    }
    await this.gitEngine.abortMerge();
    this.logger.info('Merge aborted');
    this.setState(SyncState.Idle);
    this.pause();
    await this.refreshSnapshot();
    void vscode.window.showInformationMessage(
      `Overleaf Connect: Merge aborted in ${path.basename(this.gitEngine.getWorkspacePath())}. ` +
        'Sync is paused so it does not stop on the same conflict again; your changes stay local until you resume.'
    );
  }

  private async conflictStep(step: () => Promise<void>): Promise<void> {
    if (this.isSyncing) {
      throw new Error('A sync is running; try again in a moment.');
    }
    await step();
    await this.continueMerge();
  }

  /** Finishes the merge once nothing is unmerged; otherwise only refreshes what the panel shows. */
  private async continueMerge(): Promise<void> {
    if (this.isSyncing) {
      return;
    }
    if (!(await this.gitEngine.isMerging())) {
      // Committed or aborted outside VS Code: back to normal syncing.
      this.setState(SyncState.Idle);
      this.restartAutoSync();
      await this.syncCycle();
      return;
    }
    if ((await this.gitEngine.unmergedFiles()).length) {
      await this.refreshSnapshot();
      return;
    }
    this.isSyncing = true;
    try {
      await this.gitEngine.commitMerge();
      this.setState(SyncState.Pushing);
      await this.gitEngine.push();
      this.fileWatcher.reset();
      this.logger.info('Merge resolved and pushed');
      this.markSynced();
      this.restartAutoSync();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.lastError = msg;
      this.logger.error(`Finishing the merge failed: ${msg}`);
      if (await this.gitEngine.isMerging()) {
        this.setState(SyncState.Conflict);
        void vscode.window.showErrorMessage(`Overleaf Connect: Could not commit the merge — ${msg}`);
      } else {
        // Committed but not pushed: the next sync pushes it. (start() sets Idle, so restart before marking the error.)
        this.restartAutoSync();
        this.setState(SyncState.Error);
      }
    } finally {
      this.isSyncing = false;
      await this.refreshSnapshot();
    }
  }

  private enterConflict(files: string[]): void {
    this.lastError = undefined;
    this.setState(SyncState.Conflict);
    this.stop();
    void this.conflictHandler.notify(files);
  }

  private restartAutoSync(): void {
    if (this.config.sync.enabled && !this.isPaused) {
      this.start();
    }
  }

  getState(): SyncState {
    return this.state;
  }

  private setState(state: SyncState): void {
    this.state = state;
    this._onStateChange.fire(state);
  }

  private markSynced(): void {
    this.consecutiveFailures = 0;
    this.lastSyncAt = new Date();
    this.lastError = undefined;
    this.setState(SyncState.Idle);
  }

  private async syncCycle(): Promise<void> {
    if (this.isSyncing || this.isPaused) {
      return;
    }

    if (this.state === SyncState.Conflict) {
      return;
    }

    this.isSyncing = true;

    try {
      const isRepo = await this.gitEngine.isGitRepo();
      if (!isRepo) {
        this.logger.warn('Workspace is not a git repository');
        this.isSyncing = false;
        return;
      }

      if (await this.detectConflict()) {
        return;
      }

      // Step 1: Fetch remote
      this.logger.info('Fetching remote changes...');
      await this.gitEngine.fetch();

      // Step 2: Determine sync direction
      const localChanges = this.fileWatcher.isDirty || await this.gitEngine.hasUncommittedChanges();

      let remoteChanges = false;
      // Local commits Overleaf does not have, e.g. a merge whose push failed or one left after aborting a merge.
      let ahead = false;
      try {
        const localHead = await this.gitEngine.status();
        remoteChanges = localHead.behind > 0;
        ahead = localHead.ahead > 0;
      } catch {
        remoteChanges = await this.gitEngine.hasRemoteChanges();
      }
      const localSide = localChanges || ahead;
      // Read before pulling: afterwards HEAD has moved and the old version is harder to name.
      let incoming = remoteChanges ? await this.gitEngine.incomingUpdate() : undefined;
      // Right after the pull, so a failed push does not hide what already landed; once, as the merge path may follow the rebase.
      const announcePull = () => {
        this.announce(incoming);
        incoming = undefined;
      };

      // Case A: No changes
      if (!localSide && !remoteChanges) {
        this.logger.info('No changes detected');
        this.markSynced();
        this.isSyncing = false;
        return;
      }

      // Case B: Remote changes only -> Pull
      if (!localSide && remoteChanges) {
        this.setState(SyncState.Pulling);
        this.logger.info('Pulling remote changes...');
        await this.gitEngine.pull();
        this.logger.info('Pull complete');
        this.markSynced();
        announcePull();
        this.isSyncing = false;
        return;
      }

      // Case C: Local changes only -> Commit + Push
      if (localSide && !remoteChanges) {
        this.setState(SyncState.Pushing);
        this.logger.info('Committing and pushing local changes...');
        if (localChanges) {
          await this.commitLocalChanges();
        }
        await this.gitEngine.push();
        this.fileWatcher.reset();
        this.logger.info('Push complete');
        this.markSynced();
        this.isSyncing = false;
        return;
      }

      // Case D: Both local and remote changes -> Commit + Pull (rebase) + Push
      this.logger.info('Both local and remote changes detected. Syncing...');
      if (localChanges) {
        await this.commitLocalChanges();
      }

      // Try rebase first
      this.setState(SyncState.Pulling);
      try {
        await this.gitEngine.pullRebase();
        announcePull();
        this.setState(SyncState.Pushing);
        await this.gitEngine.push();
        this.fileWatcher.reset();
        this.logger.info('Rebase and push complete');
        this.markSynced();
      } catch {
        // Rebase failed, abort and try merge
        this.logger.warn('Rebase failed, attempting merge...');
        try {
          await this.gitEngine.abortRebase();
        } catch {
          // ignore
        }
        if (await this.gitEngine.isRebasing()) {
          // The two sides would be the wrong way round for the conflict diff.
          throw new Error('A rebase with Overleaf stopped and could not be undone. Run "git rebase --abort" in the folder.');
        }

        try {
          await this.gitEngine.pullMerge();
          announcePull();
          this.setState(SyncState.Pushing);
          await this.gitEngine.push();
          this.fileWatcher.reset();
          this.logger.info('Merge and push complete');
          this.markSynced();
        } catch (mergeError) {
          const unmerged = await this.gitEngine.unmergedFiles().catch(() => []);
          if (!unmerged.length || !(await this.gitEngine.isMerging())) {
            throw mergeError;
          }
          this.logger.error(`Merge conflict in ${unmerged.length} file(s): ${unmerged.join(', ')}`);
          // Not awaited: the cycle ends now so the panel shows the conflicts while the toast is open.
          this.enterConflict(unmerged);
        }
      }
    } catch (error) {
      this.consecutiveFailures++;
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Sync failed: ${errMsg}`);
      this.lastError = errMsg;

      if (this.isAuthError(errMsg)) {
        this.setState(SyncState.Error);
        vscode.window.showErrorMessage(
          'Overleaf Connect: Authentication failed. Please reconfigure your credentials.',
          'Reconfigure'
        ).then((choice) => {
          if (choice === 'Reconfigure') {
            vscode.commands.executeCommand('overleafconnect.configure');
          }
        });
      } else {
        this.setState(SyncState.Error);
        // Schedule with backoff
        const delay = this.getRetryDelay();
        this.logger.info(`Retrying in ${delay / 1000}s...`);
      }
    } finally {
      this.isSyncing = false;
      await this.refreshSnapshot();
    }
  }

  private async commitLocalChanges(): Promise<void> {
    await this.gitEngine.addAll();
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const message = `${this.config.sync.commitMessage} [${timestamp}]`;
    await this.gitEngine.commit(message);
  }

  private isAuthError(message: string): boolean {
    const authPatterns = [
      'Authentication failed',
      'could not read Username',
      'Invalid credentials',
      'HTTP 401',
      'HTTP 403',
    ];
    return authPatterns.some((p) => message.includes(p));
  }

  private getRetryDelay(): number {
    if (this.consecutiveFailures === 0) {
      return this.config.sync.intervalSeconds * 1000;
    }
    return Math.min(
      Math.pow(2, this.consecutiveFailures) * 1000,
      this.MAX_RETRY_DELAY
    );
  }

  /** Also disposes the git engine and file watcher it was given, which it owns from then on. */
  dispose(): void {
    this.stop();
    this.gitEngine.dispose();
    this.fileWatcher.dispose();
    this._onStateChange.dispose();
    this._onSnapshotChange.dispose();
    this._onRemoteUpdate.dispose();
    this.watcherListener.dispose();
    this.conflictHandler.dispose();
    this.logger.dispose();
  }
}
