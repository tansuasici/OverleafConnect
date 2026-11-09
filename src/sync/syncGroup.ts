import type { PausableSync } from '../latex/overtex';

export interface FolderSync extends PausableSync {
  start(): void;
  stop(): void;
  dispose(): void;
}

/** One sync per workspace folder that holds an Overleaf project, driven together. */
export class SyncGroup<T extends FolderSync = FolderSync> implements PausableSync {
  private readonly syncs = new Map<string, T>();

  get size(): number {
    return this.syncs.size;
  }

  get paused(): boolean {
    return this.syncs.size > 0 && [...this.syncs.values()].every((s) => s.paused);
  }

  get(folderPath: string): T | undefined {
    return this.syncs.get(folderPath);
  }

  folders(): string[] {
    return [...this.syncs.keys()];
  }

  /** Adds a folder's sync, disposing the one it replaces. */
  set(folderPath: string, sync: T): void {
    this.syncs.get(folderPath)?.dispose();
    this.syncs.set(folderPath, sync);
  }

  remove(folderPath: string): void {
    this.syncs.get(folderPath)?.dispose();
    this.syncs.delete(folderPath);
  }

  pause(): void {
    this.syncs.forEach((s) => s.pause());
  }

  resume(): void {
    this.syncs.forEach((s) => s.resume());
  }

  start(): void {
    this.syncs.forEach((s) => s.start());
  }

  stop(): void {
    this.syncs.forEach((s) => s.stop());
  }

  async syncNow(): Promise<void> {
    for (const s of this.syncs.values()) {
      await s.syncNow();
    }
  }

  clear(): void {
    this.syncs.forEach((s) => s.dispose());
    this.syncs.clear();
  }

  dispose(): void {
    this.clear();
  }
}
