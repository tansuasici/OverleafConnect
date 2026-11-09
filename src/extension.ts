import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import simpleGit from 'simple-git';

import { AuthManager } from './auth/authManager';
import { GitEngine } from './sync/gitEngine';
import { FileWatcher } from './sync/fileWatcher';
import { SyncManager } from './sync/syncManager';
import { StatusBarManager } from './ui/statusBar';
import { LaTeXCompiler } from './latex/compiler';
import { LogParser } from './latex/logParser';
import { BibTeXManager } from './latex/bibtex';
import { PdfPreviewPanel } from './viewer/pdfPanel';
import { SyncTexService } from './viewer/synctex';
import {
  BuildSyncGate,
  chooseLatexBackend,
  LatexBackend,
  OVERTEX_ID,
  OVERTEX_SYNC_EXCLUDES,
  OvertexBuildEvents,
} from './latex/overtex';
import { SyncState } from './types';
import { getConfig } from './utils/config';
import { getOutputChannel } from './ui/outputChannel';
import { ensureGitignore } from './utils/gitignore';

let syncManager: SyncManager | undefined;
let statusBar: StatusBarManager | undefined;
const buildSyncGate = new BuildSyncGate(() => syncManager);

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = getOutputChannel();
  const config = getConfig();

  // Initialize auth
  const authManager = new AuthManager(context);

  // Initialize status bar
  statusBar = new StatusBarManager();
  context.subscriptions.push(statusBar);

  // Decide who handles LaTeX: Overtex, LaTeX Workshop, or the built-in compiler
  const backend = chooseLatexBackend((id) => !!vscode.extensions.getExtension(id));
  const syncExcludes = () => excludePatternsFor(backend, config.sync.excludePatterns);

  // ---- Register Sync Commands ----
  context.subscriptions.push(
    vscode.commands.registerCommand('overleafconnect.configure', async () => {
      const creds = await authManager.promptForCredentials();
      if (creds && vscode.workspace.workspaceFolders?.length) {
        await initializeSync(context, authManager, config, syncExcludes());
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('overleafconnect.cloneProject', async () => {
      // Always ask for project ID/URL
      const creds = await authManager.promptForClone();

      if (!creds) {
        return;
      }

      const targetFolder = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: 'Select Destination Folder',
      });

      if (!targetFolder || targetFolder.length === 0) {
        return;
      }

      const projectName = await vscode.window.showInputBox({
        prompt: 'Enter a folder name for the project',
        value: 'overleaf-project',
        ignoreFocusOut: true,
      });

      if (!projectName) {
        return;
      }

      const destPath = path.join(targetFolder[0].fsPath, projectName);

      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Cloning Overleaf project...' },
          async () => {
            const { buildAuthenticatedUrl } = await import('./auth/credentialHelper');
            const authUrl = buildAuthenticatedUrl(creds.projectUrl, 'git', creds.token);
            await simpleGit().clone(authUrl, destPath);
          }
        );

        // Create .overleafconnect marker
        const markerPath = path.join(destPath, '.overleafconnect');
        fs.writeFileSync(markerPath, JSON.stringify({
          projectUrl: creds.projectUrl,
          configured: true,
        }, null, 2));

        // Create .gitignore with exclude patterns
        await ensureGitignore(destPath, syncExcludes());

        const openChoice = await vscode.window.showInformationMessage(
          'Overleaf Connect: Project cloned successfully!',
          'Open in New Window',
          'Open in Current Window'
        );

        if (openChoice === 'Open in New Window') {
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(destPath), true);
        } else if (openChoice === 'Open in Current Window') {
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(destPath), false);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Overleaf Connect: Clone failed - ${msg}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('overleafconnect.syncNow', async () => {
      if (syncManager) {
        await syncManager.syncNow();
      } else {
        vscode.window.showWarningMessage('Overleaf Connect: Not connected to Overleaf. Please configure first.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('overleafconnect.pauseSync', () => {
      buildSyncGate.release();
      syncManager?.pause();
      statusBar?.update(SyncState.Disabled);
      vscode.window.showInformationMessage('Overleaf Connect: Auto-sync paused.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('overleafconnect.resumeSync', () => {
      buildSyncGate.release();
      syncManager?.resume();
      statusBar?.update(SyncState.Idle);
      vscode.window.showInformationMessage('Overleaf Connect: Auto-sync resumed.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('overleafconnect.logout', async () => {
      await authManager.deleteToken();
      syncManager?.stop();
      syncManager = undefined;
      statusBar?.update(SyncState.NotConfigured);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('overleafconnect.showLog', () => {
      outputChannel.show();
    })
  );

  // ---- LaTeX Features ----
  if (backend === 'overtex') {
    context.subscriptions.push(
      vscode.commands.registerCommand('overleafconnect.compile', () =>
        vscode.commands.executeCommand('overtex.build')
      ),
      vscode.commands.registerCommand('overleafconnect.viewPdf', () =>
        vscode.commands.executeCommand('overtex.viewPdf')
      ),
      vscode.commands.registerCommand('overleafconnect.syncTexForward', () =>
        vscode.commands.executeCommand('overtex.forwardSearch')
      ),
      vscode.commands.registerCommand('overleafconnect.clean', () =>
        vscode.commands.executeCommand('overtex.clean')
      )
    );

    // Not awaited: sync must start even if Overtex is slow to activate or fails to.
    void followOvertexBuilds(context, outputChannel);

    outputChannel.appendLine('[Overleaf Connect] Overtex detected - deferring LaTeX features');
  } else if (backend === 'builtin') {
    const compiler = new LaTeXCompiler(outputChannel);
    const logParser = new LogParser();
    const pdfPanel = new PdfPreviewPanel(context.extensionUri);
    const synctex = new SyncTexService();
    const bibtex = new BibTeXManager(outputChannel);

    context.subscriptions.push(compiler, logParser, pdfPanel, synctex, bibtex);

    context.subscriptions.push(
      vscode.commands.registerCommand('overleafconnect.compile', async () => {
        const texFile = getMainTexFile(config);
        if (!texFile) {
          vscode.window.showWarningMessage('Overleaf Connect: No .tex file found to compile.');
          return;
        }

        syncManager?.pause();

        const result = await compiler.compile(texFile, config);

        // Parse log and update diagnostics
        if (result.logFile) {
          const rootDir = path.dirname(texFile);
          const entries = logParser.parse(result.logFile, rootDir);
          logParser.updateDiagnostics(entries, rootDir);
        }

        // Show PDF
        if (result.success && result.pdfFile && config.viewer.autoOpen) {
          pdfPanel.show(result.pdfFile);
        } else if (!result.success) {
          vscode.window.showErrorMessage('Overleaf Connect: Compilation failed. Check Problems panel.');
        }

        syncManager?.resume();
        // Immediately sync after compilation so changes appear on Overleaf
        syncManager?.syncNow();
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('overleafconnect.viewPdf', () => {
        const texFile = getMainTexFile(config);
        if (!texFile) {
          return;
        }
        const baseName = path.basename(texFile, '.tex');
        const pdfPath = path.join(path.dirname(texFile), config.latex.outputDir, `${baseName}.pdf`);
        if (fs.existsSync(pdfPath)) {
          pdfPanel.show(pdfPath);
        } else {
          vscode.window.showWarningMessage('Overleaf Connect: No PDF found. Compile first.');
        }
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('overleafconnect.syncTexForward', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'latex') {
          return;
        }

        const texFile = editor.document.uri.fsPath;
        const line = editor.selection.active.line + 1;
        const column = editor.selection.active.character;
        const baseName = path.basename(texFile, '.tex');
        const pdfFile = path.join(path.dirname(texFile), `${baseName}.pdf`);

        const pos = await synctex.forward(texFile, line, column, pdfFile);
        if (pos) {
          pdfPanel.syncForward(pos.page, pos.x, pos.y);
        }
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('overleafconnect.clean', async () => {
        const texFile = getMainTexFile(config);
        if (texFile) {
          await compiler.clean(texFile);
          logParser.clear();
          vscode.window.showInformationMessage('Overleaf Connect: Auxiliary files cleaned.');
        }
      })
    );

    // Compile on save
    if (config.latex.compileOnSave) {
      context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async (doc) => {
          if (doc.languageId === 'latex') {
            await vscode.commands.executeCommand('overleafconnect.compile');
          }
        })
      );
    }

    // BibTeX completions
    context.subscriptions.push(bibtex.registerCompletionProvider());

    outputChannel.appendLine('[Overleaf Connect] LaTeX features enabled (LaTeX Workshop not detected)');
  } else {
    // Register noop commands to prevent errors
    context.subscriptions.push(
      vscode.commands.registerCommand('overleafconnect.compile', () => {
        vscode.window.showInformationMessage(
          'Overleaf Connect: LaTeX compilation is handled by LaTeX Workshop.'
        );
      }),
      vscode.commands.registerCommand('overleafconnect.viewPdf', () => {
        vscode.commands.executeCommand('latex-workshop.view');
      }),
      vscode.commands.registerCommand('overleafconnect.syncTexForward', () => {
        vscode.commands.executeCommand('latex-workshop.synctex');
      }),
      vscode.commands.registerCommand('overleafconnect.clean', () => {
        vscode.commands.executeCommand('latex-workshop.clean');
      })
    );

    outputChannel.appendLine('[Overleaf Connect] LaTeX Workshop detected - deferring LaTeX features');
  }

  // The backend is fixed for this session, so installing or removing Overtex needs a reload.
  let reloadOffered = false;
  context.subscriptions.push(
    vscode.extensions.onDidChange(() => {
      const hasOvertex = !!vscode.extensions.getExtension(OVERTEX_ID);
      if (reloadOffered || hasOvertex === (backend === 'overtex')) {
        return;
      }
      reloadOffered = true;
      void vscode.window
        .showInformationMessage(
          'Overleaf Connect: Reload the window to change which extension builds your LaTeX.',
          'Reload Window'
        )
        .then((choice) => {
          if (choice === 'Reload Window') {
            void vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        });
    })
  );

  // ---- Sync on save (works regardless of the LaTeX backend) ----
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (syncManager && (doc.languageId === 'latex' || doc.fileName.endsWith('.bib'))) {
        outputChannel.appendLine('[Overleaf Connect] File saved, triggering sync...');
        await syncManager.syncNow();
      }
    })
  );

  // ---- Initialize Sync if already configured ----
  if (await authManager.isAuthenticated() && vscode.workspace.workspaceFolders?.length) {
    await initializeSync(context, authManager, config, syncExcludes());
  } else {
    statusBar.update(SyncState.NotConfigured);
  }

  // ---- React to config changes ----
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('overleafconnect')) {
        if (syncManager && e.affectsConfiguration('overleafconnect.sync.intervalSeconds')) {
          syncManager.stop();
          syncManager.start();
        }
        outputChannel.appendLine('[Overleaf Connect] Configuration updated');
      }
    })
  );

  outputChannel.appendLine('[Overleaf Connect] Extension activated');
}

async function initializeSync(
  context: vscode.ExtensionContext,
  authManager: AuthManager,
  config: ReturnType<typeof getConfig>,
  excludePatterns: string[]
): Promise<void> {
  // Dispose previous sync instance if reconfiguring
  if (syncManager) {
    syncManager.dispose();
    syncManager = undefined;
  }

  const workspacePath = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const token = (await authManager.getToken())!;
  const projectUrl = (await authManager.getProjectUrl())!;

  const gitEngine = new GitEngine({
    workspacePath,
    remoteUrl: projectUrl,
    username: 'git',
    token,
  });

  // Check if it's a git repo
  const isRepo = await gitEngine.isGitRepo();
  if (!isRepo) {
    const outputChannel = getOutputChannel();
    outputChannel.appendLine('[Overleaf Connect] Workspace is not a git repository. Use "Clone Overleaf Project" first.');
    statusBar?.update(SyncState.NotConfigured);
    gitEngine.dispose();
    return;
  }

  // Ensure .gitignore has exclude patterns
  await ensureGitignore(workspacePath, excludePatterns);

  const fileWatcher = new FileWatcher(workspacePath);
  syncManager = new SyncManager(gitEngine, fileWatcher, config);

  // Wire up status bar
  syncManager.onDidChangeState((state) => statusBar!.update(state));

  // Pull on open
  if (config.sync.pullOnOpen) {
    await syncManager.syncNow();
  }

  // Start auto-sync
  if (config.sync.enabled) {
    syncManager.start();
  }

  context.subscriptions.push(gitEngine, fileWatcher, syncManager);
}

function excludePatternsFor(backend: LatexBackend, patterns: string[]): string[] {
  return backend === 'overtex' ? [...patterns, ...OVERTEX_SYNC_EXCLUDES] : patterns;
}

/** Holds sync back during every Overtex build, including the ones it starts on save. */
async function followOvertexBuilds(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  try {
    const api = await vscode.extensions.getExtension<OvertexBuildEvents>(OVERTEX_ID)?.activate();
    if (!api?.onDidStartBuild || !api.onDidEndBuild) {
      outputChannel.appendLine('[Overleaf Connect] This Overtex version has no build events; sync continues during builds');
      return;
    }
    context.subscriptions.push(
      api.onDidStartBuild(() => buildSyncGate.buildStarted()),
      api.onDidEndBuild(() => void buildSyncGate.buildEnded())
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Overleaf Connect] Could not connect to Overtex: ${msg}`);
  }
}

function getMainTexFile(config: ReturnType<typeof getConfig>): string | null {
  // If main file is configured, use it
  if (config.latex.mainFile) {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspacePath) {
      return path.join(workspacePath, config.latex.mainFile);
    }
  }

  // Try active editor
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.languageId === 'latex') {
    return editor.document.uri.fsPath;
  }

  // Auto-detect: look for main.tex or any .tex with \documentclass
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspacePath) {
    return null;
  }

  const mainTex = path.join(workspacePath, 'main.tex');
  if (fs.existsSync(mainTex)) {
    return mainTex;
  }

  // Search for \documentclass in .tex files
  try {
    const files = fs.readdirSync(workspacePath);
    for (const file of files) {
      if (file.endsWith('.tex')) {
        const content = fs.readFileSync(path.join(workspacePath, file), 'utf-8');
        if (content.includes('\\documentclass')) {
          return path.join(workspacePath, file);
        }
      }
    }
  } catch {
    // ignore
  }

  return null;
}

export function deactivate(): void {
  syncManager?.stop();
}
