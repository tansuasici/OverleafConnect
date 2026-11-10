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
  overleaf: {
    serverUrl: string;
  };
  notifications: {
    /** How changes pulled from Overleaf are announced. */
    remoteChanges: 'notification' | 'statusBar' | 'off';
  };
}

export enum ErrorCategory {
  Network = 'network',
  Auth = 'auth',
  GitConflict = 'gitConflict',
  GitGeneral = 'gitGeneral',
  Configuration = 'configuration',
}
