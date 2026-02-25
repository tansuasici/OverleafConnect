import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { CompileResult, CompileOptions, ExtensionConfig } from '../types';

export class LaTeXCompiler implements vscode.Disposable {
  private process: cp.ChildProcess | null = null;
  private outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  async compile(texFile: string, config: ExtensionConfig, options?: CompileOptions): Promise<CompileResult> {
    const startTime = Date.now();
    const compiler = options?.compiler ?? config.latex.compiler;
    const args = this.buildArgs(texFile, config, options);
    const cwd = path.dirname(texFile);
    const outputDir = options?.outputDir ?? config.latex.outputDir;

    this.outputChannel.appendLine(`[Overleaf Connect] Compiling: ${compiler} ${args.join(' ')}`);
    this.outputChannel.show(true);

    return new Promise<CompileResult>((resolve) => {
      this.process = cp.spawn(compiler, args, { cwd });

      let stdout = '';
      let stderr = '';

      this.process.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        this.outputChannel.append(text);
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        this.outputChannel.append(text);
      });

      this.process.on('close', (exitCode) => {
        this.process = null;
        const duration = Date.now() - startTime;
        const baseName = path.basename(texFile, '.tex');
        const outDir = outputDir === '.' ? cwd : path.resolve(cwd, outputDir);
        const pdfFile = exitCode === 0 ? path.join(outDir, `${baseName}.pdf`) : null;
        const logFile = path.join(outDir, `${baseName}.log`);

        this.outputChannel.appendLine(
          `[Overleaf Connect] Compilation ${exitCode === 0 ? 'succeeded' : 'failed'} in ${duration}ms`
        );

        resolve({
          success: exitCode === 0,
          exitCode: exitCode ?? 1,
          logFile,
          pdfFile,
          duration,
        });
      });

      this.process.on('error', (err) => {
        this.process = null;
        this.outputChannel.appendLine(`[Overleaf Connect] Compiler error: ${err.message}`);
        resolve({
          success: false,
          exitCode: -1,
          logFile: '',
          pdfFile: null,
          duration: Date.now() - startTime,
        });
      });
    });
  }

  async clean(texFile: string): Promise<void> {
    const cwd = path.dirname(texFile);
    const baseName = path.basename(texFile, '.tex');
    const extensions = ['.aux', '.log', '.synctex.gz', '.fls', '.fdb_latexmk', '.bbl', '.blg', '.out', '.toc'];

    for (const ext of extensions) {
      const file = vscode.Uri.file(path.join(cwd, baseName + ext));
      try {
        await vscode.workspace.fs.delete(file);
      } catch {
        // File might not exist
      }
    }

    this.outputChannel.appendLine('[Overleaf Connect] Auxiliary files cleaned');
  }

  cancel(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
      this.outputChannel.appendLine('[Overleaf Connect] Compilation cancelled');
    }
  }

  private buildArgs(texFile: string, config: ExtensionConfig, options?: CompileOptions): string[] {
    const args: string[] = [...config.latex.args];

    if (options?.outputDir && options.outputDir !== '.') {
      args.push(`-outdir=${options.outputDir}`);
    } else if (config.latex.outputDir !== '.') {
      args.push(`-outdir=${config.latex.outputDir}`);
    }

    args.push(texFile);
    return args;
  }

  dispose(): void {
    this.cancel();
  }
}
