import * as vscode from 'vscode';
import { GitEngine } from './gitEngine';

export class ConflictHandler implements vscode.Disposable {
  constructor(private gitEngine: GitEngine) {}

  async handleConflict(): Promise<'resolved' | 'aborted'> {
    const conflictedFiles = await this.gitEngine.getConflictedFiles();

    if (conflictedFiles.length === 0) {
      return 'resolved';
    }

    const choice = await vscode.window.showWarningMessage(
      `Overleaf Connect: Merge conflict detected in ${conflictedFiles.length} file(s). Please resolve conflicts and sync again.`,
      'Open Conflicts',
      'Abort Merge'
    );

    if (choice === 'Open Conflicts') {
      await this.openConflictedFiles(conflictedFiles);
      return 'resolved';
    }

    if (choice === 'Abort Merge') {
      try {
        await this.gitEngine.abortMerge();
      } catch {
        try {
          await this.gitEngine.abortRebase();
        } catch {
          // ignore if nothing to abort
        }
      }
      return 'aborted';
    }

    return 'resolved';
  }

  private async openConflictedFiles(files: string[]): Promise<void> {
    const workspacePath = this.gitEngine.getWorkspacePath();
    for (const file of files) {
      const uri = vscode.Uri.file(`${workspacePath}/${file}`);
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch {
        // File might not exist
      }
    }
  }

  dispose(): void {
    // No resources to clean up
  }
}
