export interface GitEngineOptions {
  workspacePath: string;
  remoteUrl: string;
  username: string;
  token: string;
}

export enum SyncState {
  Idle = 'idle',
  Pulling = 'pulling',
  Pushing = 'pushing',
  Conflict = 'conflict',
  Error = 'error',
  Disabled = 'disabled',
  NotConfigured = 'notConfigured',
}

export interface ExtensionConfig {
  sync: {
    enabled: boolean;
    intervalSeconds: number;
    commitMessage: string;
    pullOnOpen: boolean;
    pushOnSave: boolean;
    excludePatterns: string[];
  };
  latex: {
    compiler: 'latexmk' | 'pdflatex' | 'xelatex' | 'lualatex';
    args: string[];
    outputDir: string;
    compileOnSave: boolean;
    mainFile: string;
    bibCompiler: 'bibtex' | 'biber';
  };
  viewer: {
    autoOpen: boolean;
    zoomLevel: number;
  };
  overleaf: {
    serverUrl: string;
  };
}

export interface CompileResult {
  success: boolean;
  exitCode: number;
  logFile: string;
  pdfFile: string | null;
  duration: number;
}

export interface CompileOptions {
  compiler?: 'latexmk' | 'pdflatex' | 'xelatex' | 'lualatex';
  args?: string[];
  outputDir?: string;
  synctex?: boolean;
}

export interface LogEntry {
  type: 'error' | 'warning' | 'info';
  message: string;
  file: string;
  line: number;
  column?: number;
  raw: string;
}

export enum ErrorCategory {
  Network = 'network',
  Auth = 'auth',
  GitConflict = 'gitConflict',
  GitGeneral = 'gitGeneral',
  Compilation = 'compilation',
  Configuration = 'configuration',
}
