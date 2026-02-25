import * as vscode from 'vscode';
import { SyncState } from '../types';

export class StatusBarManager implements vscode.Disposable {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.item.command = 'overleafconnect.syncNow';
    this.item.show();
  }

  update(state: SyncState): void {
    switch (state) {
      case SyncState.Idle:
        this.item.text = '$(cloud) Overleaf Connect';
        this.item.tooltip = 'Synced with Overleaf. Click to sync now.';
        this.item.backgroundColor = undefined;
        this.item.command = 'overleafconnect.syncNow';
        break;
      case SyncState.Pulling:
        this.item.text = '$(sync~spin) Pulling...';
        this.item.tooltip = 'Pulling changes from Overleaf...';
        this.item.backgroundColor = undefined;
        break;
      case SyncState.Pushing:
        this.item.text = '$(sync~spin) Pushing...';
        this.item.tooltip = 'Pushing changes to Overleaf...';
        this.item.backgroundColor = undefined;
        break;
      case SyncState.Conflict:
        this.item.text = '$(warning) Conflict';
        this.item.tooltip = 'Merge conflict detected. Click to resolve.';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.item.command = 'overleafconnect.syncNow';
        break;
      case SyncState.Error:
        this.item.text = '$(error) Sync Error';
        this.item.tooltip = 'Sync failed. Click to retry.';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        this.item.command = 'overleafconnect.syncNow';
        break;
      case SyncState.Disabled:
        this.item.text = '$(circle-slash) Sync Off';
        this.item.tooltip = 'Auto-sync disabled. Click to enable.';
        this.item.backgroundColor = undefined;
        this.item.command = 'overleafconnect.resumeSync';
        break;
      case SyncState.NotConfigured:
        this.item.text = '$(plug) Setup Overleaf Connect';
        this.item.tooltip = 'Click to configure Overleaf connection.';
        this.item.backgroundColor = undefined;
        this.item.command = 'overleafconnect.configure';
        break;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
