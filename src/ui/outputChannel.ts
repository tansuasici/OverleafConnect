import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Overleaf Connect');
  }
  return channel;
}

export function disposeOutputChannel(): void {
  channel?.dispose();
  channel = undefined;
}
