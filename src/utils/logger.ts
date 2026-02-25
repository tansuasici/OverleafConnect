import * as vscode from 'vscode';

export class Logger {
  private outputChannel: vscode.OutputChannel;

  constructor(name: string) {
    this.outputChannel = vscode.window.createOutputChannel(name);
  }

  info(message: string): void {
    this.log('INFO', message);
  }

  warn(message: string): void {
    this.log('WARN', message);
  }

  error(message: string, error?: Error): void {
    this.log('ERROR', message);
    if (error?.stack) {
      this.outputChannel.appendLine(error.stack);
    }
  }

  private log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] [${level}] ${message}`);
  }

  show(): void {
    this.outputChannel.show();
  }

  dispose(): void {
    this.outputChannel.dispose();
  }
}
