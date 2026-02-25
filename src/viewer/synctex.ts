import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

interface SyncTexPosition {
  page: number;
  x: number;
  y: number;
}

interface SyncTexSource {
  file: string;
  line: number;
  column: number;
}

export class SyncTexService implements vscode.Disposable {
  /**
   * Forward search: source file position -> PDF position
   */
  async forward(
    texFile: string,
    line: number,
    column: number,
    pdfFile: string
  ): Promise<SyncTexPosition | null> {
    const args = ['view', '-i', `${line}:${column}:${texFile}`, '-o', pdfFile];

    try {
      const output = await this.runSynctex(args, path.dirname(texFile));
      return this.parseForwardOutput(output);
    } catch {
      return null;
    }
  }

  /**
   * Inverse search: PDF position -> source file position
   */
  async inverse(
    pdfFile: string,
    page: number,
    x: number,
    y: number
  ): Promise<SyncTexSource | null> {
    const args = ['edit', '-o', `${page}:${x}:${y}:${pdfFile}`];

    try {
      const output = await this.runSynctex(args, path.dirname(pdfFile));
      return this.parseInverseOutput(output);
    } catch {
      return null;
    }
  }

  private runSynctex(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = cp.spawn('synctex', args, { cwd });
      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`synctex exited with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  private parseForwardOutput(output: string): SyncTexPosition | null {
    const pageMatch = output.match(/Page:(\d+)/);
    const xMatch = output.match(/x:([0-9.]+)/);
    const yMatch = output.match(/y:([0-9.]+)/);

    if (pageMatch && xMatch && yMatch) {
      return {
        page: parseInt(pageMatch[1], 10),
        x: parseFloat(xMatch[1]),
        y: parseFloat(yMatch[1]),
      };
    }
    return null;
  }

  private parseInverseOutput(output: string): SyncTexSource | null {
    const inputMatch = output.match(/Input:(.+)/);
    const lineMatch = output.match(/Line:(\d+)/);
    const columnMatch = output.match(/Column:(-?\d+)/);

    if (inputMatch && lineMatch) {
      return {
        file: inputMatch[1].trim(),
        line: parseInt(lineMatch[1], 10),
        column: columnMatch ? Math.max(0, parseInt(columnMatch[1], 10)) : 0,
      };
    }
    return null;
  }

  dispose(): void {
    // No resources to clean up
  }
}
