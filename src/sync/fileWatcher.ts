import * as vscode from 'vscode';

const DEBOUNCE_MS = 500;

const DEFAULT_IGNORE_PATTERNS = [
  '**/.git/**',
  '**/*.aux',
  '**/*.log',
  '**/*.synctex.gz',
  '**/*.fls',
  '**/*.fdb_latexmk',
  '**/*.bbl',
  '**/*.blg',
  '**/*.out',
  '**/*.toc',
];

export class FileWatcher implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher;
  private saveListener: vscode.Disposable;
  private _isDirty = false;
  private debounceTimer: NodeJS.Timeout | null = null;
  private disposables: vscode.Disposable[] = [];

  private readonly _onDirtyChange = new vscode.EventEmitter<boolean>();
  public readonly onDidChangeDirty = this._onDirtyChange.event;

  constructor(private workspacePath: string) {
    const pattern = new vscode.RelativePattern(workspacePath, '**/*');
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.watcher.onDidChange((uri) => this.onFileEvent(uri), null, this.disposables);
    this.watcher.onDidCreate((uri) => this.onFileEvent(uri), null, this.disposables);
    this.watcher.onDidDelete((uri) => this.onFileEvent(uri), null, this.disposables);

    this.saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.fsPath.startsWith(workspacePath)) {
        if (!this.shouldIgnore(doc.uri.fsPath)) {
          this.markDirty();
        }
      }
    });
    this.disposables.push(this.saveListener);
  }

  get isDirty(): boolean {
    return this._isDirty;
  }

  reset(): void {
    this._isDirty = false;
    this._onDirtyChange.fire(false);
  }

  private onFileEvent(uri: vscode.Uri): void {
    if (!this.shouldIgnore(uri.fsPath)) {
      this.markDirty();
    }
  }

  private markDirty(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this._isDirty = true;
      this._onDirtyChange.fire(true);
      this.debounceTimer = null;
    }, DEBOUNCE_MS);
  }

  private shouldIgnore(filePath: string): boolean {
    const relative = filePath.replace(this.workspacePath, '');
    return DEFAULT_IGNORE_PATTERNS.some((pattern) => {
      if (pattern.includes('**/.git/**')) {
        return relative.includes('/.git/') || relative.includes('\\.git\\');
      }
      const ext = pattern.replace('**/*', '');
      return relative.endsWith(ext);
    });
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.watcher.dispose();
    this._onDirtyChange.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
