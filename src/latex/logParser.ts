import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LogEntry } from '../types';

export class LogParser implements vscode.Disposable {
  private diagnosticCollection: vscode.DiagnosticCollection;

  constructor() {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection('overleafconnect-latex');
  }

  parse(logFilePath: string, rootDir: string): LogEntry[] {
    let content: string;
    try {
      content = fs.readFileSync(logFilePath, 'utf-8');
    } catch {
      return [];
    }

    const entries: LogEntry[] = [];
    const lines = content.split('\n');
    const fileStack: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Track file context via ( and )
      this.updateFileStack(line, fileStack);

      const currentFile = fileStack.length > 0
        ? fileStack[fileStack.length - 1]
        : '';

      // Error: ! <message>
      if (line.startsWith('! ')) {
        const message = line.substring(2).trim();
        let errorLine = 0;
        // Look for l.<number> on subsequent lines
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const lineMatch = lines[j].match(/^l\.(\d+)\s/);
          if (lineMatch) {
            errorLine = parseInt(lineMatch[1], 10);
            break;
          }
        }
        entries.push({
          type: 'error',
          message,
          file: this.resolveFile(currentFile, rootDir),
          line: errorLine,
          raw: line,
        });
      }

      // LaTeX Warning
      const latexWarning = line.match(/LaTeX Warning:\s*(.+?)(?:\s+on input line (\d+))?\.?\s*$/);
      if (latexWarning) {
        entries.push({
          type: 'warning',
          message: latexWarning[1].trim(),
          file: this.resolveFile(currentFile, rootDir),
          line: latexWarning[2] ? parseInt(latexWarning[2], 10) : 0,
          raw: line,
        });
      }

      // Package Warning
      const pkgWarning = line.match(/Package (\w+) Warning:\s*(.+?)(?:\s+on input line (\d+))?\.?\s*$/);
      if (pkgWarning) {
        entries.push({
          type: 'warning',
          message: `[${pkgWarning[1]}] ${pkgWarning[2].trim()}`,
          file: this.resolveFile(currentFile, rootDir),
          line: pkgWarning[3] ? parseInt(pkgWarning[3], 10) : 0,
          raw: line,
        });
      }

      // Overfull/Underfull box
      const boxWarning = line.match(/^(Over|Under)full \\[hv]box .+ at lines (\d+)--(\d+)/);
      if (boxWarning) {
        entries.push({
          type: 'info',
          message: line.trim(),
          file: this.resolveFile(currentFile, rootDir),
          line: parseInt(boxWarning[2], 10),
          raw: line,
        });
      }
    }

    return entries;
  }

  updateDiagnostics(entries: LogEntry[], rootDir: string): void {
    this.diagnosticCollection.clear();

    const diagnosticsMap = new Map<string, vscode.Diagnostic[]>();

    for (const entry of entries) {
      const filePath = entry.file || path.join(rootDir, 'main.tex');
      const uri = filePath;

      if (!diagnosticsMap.has(uri)) {
        diagnosticsMap.set(uri, []);
      }

      const severity = entry.type === 'error'
        ? vscode.DiagnosticSeverity.Error
        : entry.type === 'warning'
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information;

      const line = Math.max(0, entry.line - 1);
      const range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
      const diagnostic = new vscode.Diagnostic(range, entry.message, severity);
      diagnostic.source = 'Overleaf Connect';

      diagnosticsMap.get(uri)!.push(diagnostic);
    }

    for (const [filePath, diagnostics] of diagnosticsMap) {
      this.diagnosticCollection.set(vscode.Uri.file(filePath), diagnostics);
    }
  }

  clear(): void {
    this.diagnosticCollection.clear();
  }

  private updateFileStack(line: string, stack: string[]): void {
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '(') {
        // Extract filename after this specific (
        const rest = line.substring(i + 1).trim();
        const fileMatch = rest.match(/^([^\s)]+)/);
        if (fileMatch && (fileMatch[1].endsWith('.tex') || fileMatch[1].endsWith('.sty') || fileMatch[1].endsWith('.cls'))) {
          stack.push(fileMatch[1]);
        }
      } else if (char === ')' && stack.length > 0) {
        stack.pop();
      }
    }
  }

  private resolveFile(file: string, rootDir: string): string {
    if (!file) {
      return '';
    }
    if (path.isAbsolute(file)) {
      return file;
    }
    return path.resolve(rootDir, file);
  }

  dispose(): void {
    this.diagnosticCollection.dispose();
  }
}
