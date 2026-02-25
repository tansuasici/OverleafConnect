import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import simpleGit from 'simple-git';

const SECTION_HEADER = '# Overleaf Connect';

/**
 * Ensures a .gitignore file exists in the workspace with the given patterns.
 * - If no .gitignore exists, creates one with the patterns.
 * - If .gitignore exists, appends missing patterns under an "# Overleaf Connect" section.
 * - If tracked files match gitignore patterns, prompts user to untrack them.
 */
export async function ensureGitignore(workspacePath: string, patterns: string[]): Promise<void> {
  const gitignorePath = path.join(workspacePath, '.gitignore');
  const allPatterns = ['.overleafconnect', ...patterns];

  if (!fs.existsSync(gitignorePath)) {
    const content = `${SECTION_HEADER}\n${allPatterns.join('\n')}\n`;
    fs.writeFileSync(gitignorePath, content, 'utf-8');
  } else {
    const existing = fs.readFileSync(gitignorePath, 'utf-8');
    const existingLines = new Set(
      existing.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
    );

    const missing = allPatterns.filter((p) => !existingLines.has(p));

    if (missing.length > 0) {
      const separator = existing.endsWith('\n') ? '' : '\n';
      const addition = `${separator}\n${SECTION_HEADER}\n${missing.join('\n')}\n`;
      fs.appendFileSync(gitignorePath, addition, 'utf-8');
    }
  }

  // Check for tracked files that should be ignored
  await promptUntrackIfNeeded(workspacePath);
}

/**
 * Finds tracked files that match .gitignore patterns and offers to untrack them.
 */
async function promptUntrackIfNeeded(workspacePath: string): Promise<void> {
  try {
    const git = simpleGit({ baseDir: workspacePath });

    // git ls-files -i --exclude-standard: list tracked files that match gitignore
    const result = await git.raw(['ls-files', '-i', '--exclude-standard']);
    const trackedIgnored = result.trim().split('\n').filter((f) => f.length > 0);

    if (trackedIgnored.length === 0) {
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `Overleaf Connect: ${trackedIgnored.length} file(s) are tracked by git but should be ignored (e.g. ${trackedIgnored[0]}). Remove them from tracking?`,
      'Yes, untrack them',
      'Show files',
      'Ignore'
    );

    if (choice === 'Yes, untrack them') {
      await git.raw(['rm', '--cached', ...trackedIgnored]);
      await git.add('.gitignore');
      await git.commit('Remove tracked build artifacts via Overleaf Connect');
      vscode.window.showInformationMessage(
        `Overleaf Connect: ${trackedIgnored.length} file(s) removed from tracking.`
      );
    } else if (choice === 'Show files') {
      const doc = await vscode.workspace.openTextDocument({
        content: trackedIgnored.join('\n'),
        language: 'text',
      });
      await vscode.window.showTextDocument(doc);
    }
  } catch {
    // Silently ignore - not critical
  }
}
