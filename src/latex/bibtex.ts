import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface BibEntry {
  key: string;
  type: string;
  title: string;
  author: string;
  year: string;
}

export class BibTeXManager implements vscode.Disposable {
  private outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  async compile(auxFile: string, compiler: 'bibtex' | 'biber'): Promise<void> {
    const cwd = path.dirname(auxFile);
    const baseName = path.basename(auxFile, '.aux');

    return new Promise<void>((resolve, reject) => {
      const args = compiler === 'biber' ? [baseName] : [baseName];
      const proc = cp.spawn(compiler, args, { cwd });

      proc.stdout?.on('data', (data: Buffer) => {
        this.outputChannel.append(data.toString());
      });

      proc.stderr?.on('data', (data: Buffer) => {
        this.outputChannel.append(data.toString());
      });

      proc.on('close', (code) => {
        if (code === 0) {
          this.outputChannel.appendLine(`[Overleaf Connect] ${compiler} completed successfully`);
          resolve();
        } else {
          reject(new Error(`${compiler} exited with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  parseBibFile(bibFilePath: string): BibEntry[] {
    let content: string;
    try {
      content = fs.readFileSync(bibFilePath, 'utf-8');
    } catch {
      return [];
    }

    const entries: BibEntry[] = [];
    const entryRegex = /@(\w+)\s*\{\s*([^,]+),/g;
    let match;

    while ((match = entryRegex.exec(content)) !== null) {
      const type = match[1].toLowerCase();
      const key = match[2].trim();

      // Extract fields from the entry block
      const startIdx = match.index;
      let braceCount = 0;
      let endIdx = startIdx;

      for (let i = content.indexOf('{', startIdx); i < content.length; i++) {
        if (content[i] === '{') {braceCount++;}
        if (content[i] === '}') {braceCount--;}
        if (braceCount === 0) {
          endIdx = i;
          break;
        }
      }

      const block = content.substring(startIdx, endIdx + 1);
      const title = this.extractField(block, 'title');
      const author = this.extractField(block, 'author');
      const year = this.extractField(block, 'year');

      if (type !== 'string' && type !== 'comment' && type !== 'preamble') {
        entries.push({ key, type, title, author, year });
      }
    }

    return entries;
  }

  registerCompletionProvider(): vscode.Disposable {
    return vscode.languages.registerCompletionItemProvider(
      { language: 'latex', scheme: 'file' },
      {
        provideCompletionItems: (document, position) => {
          const lineText = document.lineAt(position).text;
          const beforeCursor = lineText.substring(0, position.character);

          // Check if we're inside \cite{...}
          if (!beforeCursor.match(/\\cite\w*\{[^}]*$/)) {
            return undefined;
          }

          const items: vscode.CompletionItem[] = [];
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
          if (!workspaceFolder) {
            return items;
          }

          // Find all .bib files in workspace
          const bibFiles = this.findBibFiles(workspaceFolder.uri.fsPath);
          for (const bibFile of bibFiles) {
            const entries = this.parseBibFile(bibFile);
            for (const entry of entries) {
              const item = new vscode.CompletionItem(entry.key, vscode.CompletionItemKind.Reference);
              item.detail = `[${entry.type}] ${entry.year}`;
              item.documentation = new vscode.MarkdownString(
                `**${entry.title}**\n\n${entry.author}\n\n*${entry.year}*`
              );
              items.push(item);
            }
          }

          return items;
        },
      },
      '{', ','
    );
  }

  private extractField(block: string, field: string): string {
    const regex = new RegExp(`${field}\\s*=\\s*[{"]([^}"]+)[}"]`, 'i');
    const match = block.match(regex);
    return match ? match[1].trim() : '';
  }

  private findBibFiles(rootPath: string): string[] {
    const bibFiles: string[] = [];
    try {
      const files = fs.readdirSync(rootPath);
      for (const file of files) {
        if (file.endsWith('.bib')) {
          bibFiles.push(path.join(rootPath, file));
        }
      }
    } catch {
      // ignore
    }
    return bibFiles;
  }

  dispose(): void {
    // No resources to clean up
  }
}
