import * as vscode from 'vscode';
import { GitEngine } from './gitEngine';
import { FileWatcher } from './fileWatcher';
import { ConflictHandler } from './conflictHandler';
import { SyncState, ExtensionConfig } from '../types';
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

  constructor(
    private gitEngine: GitEngine,
    private fileWatcher: FileWatcher,
    private config: ExtensionConfig
  ) {
    this.conflictHandler = new ConflictHandler(gitEngine);
  }

  start(): void {
    if (this.timer) {
      return;
    }
    const intervalMs = this.config.sync.intervalSeconds * 1000;
    this.timer = setInterval(() => this.syncCycle(), intervalMs);
    this.logger.info(`Auto-sync started (every ${this.config.sync.intervalSeconds}s)`);
    this.setState(SyncState.Idle);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info('Auto-sync stopped');
  }

  pause(): void {
    this.isPaused = true;
    this.logger.info('Auto-sync paused');
  }

  resume(): void {
    this.isPaused = false;
    this.logger.info('Auto-sync resumed');
  }

  async syncNow(): Promise<void> {
    await this.syncCycle();
  }

  getState(): SyncState {
    return this.state;
  }

  private setState(state: SyncState): void {
    this.state = state;
    this._onStateChange.fire(state);
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

      // Step 1: Fetch remote
      this.logger.info('Fetching remote changes...');
      await this.gitEngine.fetch();

      // Step 2: Determine sync direction
      const localChanges = this.fileWatcher.isDirty || await this.gitEngine.hasUncommittedChanges();

      let remoteChanges = false;
      try {
        const localHead = await this.gitEngine.status();
        remoteChanges = localHead.behind > 0;
      } catch {
        remoteChanges = await this.gitEngine.hasRemoteChanges();
      }

      // Case A: No changes
      if (!localChanges && !remoteChanges) {
        this.logger.info('No changes detected');
        this.setState(SyncState.Idle);
        this.consecutiveFailures = 0;
        this.isSyncing = false;
        return;
      }

      // Case B: Remote changes only -> Pull
      if (!localChanges && remoteChanges) {
        this.setState(SyncState.Pulling);
        this.logger.info('Pulling remote changes...');
        await this.gitEngine.pull();
        this.logger.info('Pull complete');
        this.setState(SyncState.Idle);
        this.consecutiveFailures = 0;
        this.isSyncing = false;
        return;
      }

      // Case C: Local changes only -> Commit + Push
      if (localChanges && !remoteChanges) {
        this.setState(SyncState.Pushing);
        this.logger.info('Committing and pushing local changes...');
        await this.commitLocalChanges();
        await this.gitEngine.push();
        this.fileWatcher.reset();
        this.logger.info('Push complete');
        this.setState(SyncState.Idle);
        this.consecutiveFailures = 0;
        this.isSyncing = false;
        return;
      }

      // Case D: Both local and remote changes -> Commit + Pull (rebase) + Push
      this.logger.info('Both local and remote changes detected. Syncing...');
      await this.commitLocalChanges();

      // Try rebase first
      this.setState(SyncState.Pulling);
      try {
        await this.gitEngine.pullRebase();
        this.setState(SyncState.Pushing);
        await this.gitEngine.push();
        this.fileWatcher.reset();
        this.logger.info('Rebase and push complete');
        this.setState(SyncState.Idle);
        this.consecutiveFailures = 0;
      } catch {
        // Rebase failed, abort and try merge
        this.logger.warn('Rebase failed, attempting merge...');
        try {
          await this.gitEngine.abortRebase();
        } catch {
          // ignore
        }

        try {
          await this.gitEngine.pullMerge();
          this.setState(SyncState.Pushing);
          await this.gitEngine.push();
          this.fileWatcher.reset();
          this.logger.info('Merge and push complete');
          this.setState(SyncState.Idle);
          this.consecutiveFailures = 0;
        } catch {
          // Merge has conflicts
          this.logger.error('Merge conflict detected');
          this.setState(SyncState.Conflict);
          this.stop(); // Stop auto-sync until resolved
          await this.conflictHandler.handleConflict();
        }
      }
    } catch (error) {
      this.consecutiveFailures++;
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Sync failed: ${errMsg}`);

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

  dispose(): void {
    this.stop();
    this._onStateChange.dispose();
    this.conflictHandler.dispose();
    this.logger.dispose();
  }
}
