import * as vscode from 'vscode';
import * as path from 'path';
import { GitEngine } from './gitEngine';

/** Tells the user a merge with Overleaf stopped on conflicts and points them at the diff. */
export class ConflictHandler implements vscode.Disposable {
  constructor(private gitEngine: GitEngine, private readonly onAbort: () => Promise<void>) {}

  /** Not awaited by the sync cycle: the toast may stay open while the user resolves files from the panel. */
  async notify(files: string[]): Promise<void> {
    if (!files.length) {
      return;
    }
    const folderPath = this.gitEngine.getWorkspacePath();
    const choice = await vscode.window.showWarningMessage(
      `Overleaf Connect: ${files.length} file(s) in ${path.basename(folderPath)} changed both here and on Overleaf. ` +
        'Compare them and pick a version in the Overleaf panel; sync resumes once all are resolved.',
      'Compare',
      'Abort Merge'
    );
    if (choice === 'Compare') {
      await vscode.commands.executeCommand('workbench.view.extension.overleafconnect');
      await vscode.commands.executeCommand('overleafconnect.showConflict', { folderPath, relativePath: files[0] });
    } else if (choice === 'Abort Merge') {
      try {
        await this.onAbort();
      } catch (error) {
        vscode.window.showErrorMessage(`Overleaf Connect: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  dispose(): void {
    // No resources to clean up
  }
}
