import * as vscode from 'vscode';
import * as path from 'path';

export class PdfPreviewPanel implements vscode.Disposable {
  public static readonly viewType = 'overleafconnect.pdfPreview';
  private panel: vscode.WebviewPanel | undefined;
  private extensionUri: vscode.Uri;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
  }

  show(pdfPath: string): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.refresh(pdfPath);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        PdfPreviewPanel.viewType,
        'PDF Preview',
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(this.extensionUri, 'media'),
            vscode.Uri.file(path.dirname(pdfPath)),
          ],
        }
      );

      this.panel.webview.html = this.getHtml(pdfPath);

      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    }
  }

  refresh(pdfPath: string): void {
    if (!this.panel) {
      return;
    }
    const pdfUri = this.panel.webview.asWebviewUri(vscode.Uri.file(pdfPath));
    this.panel.webview.postMessage({
      type: 'refresh',
      pdfUri: pdfUri.toString(),
    });
  }

  syncForward(page: number, x: number, y: number): void {
    this.panel?.webview.postMessage({
      type: 'syncForward',
      page,
      x,
      y,
    });
  }

  isVisible(): boolean {
    return this.panel?.visible ?? false;
  }

  private getHtml(pdfPath: string): string {
    const pdfUri = this.panel!.webview.asWebviewUri(vscode.Uri.file(pdfPath));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-src ${this.panel!.webview.cspSource} blob: data:; object-src blob: data:;">
  <title>PDF Preview</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background: var(--vscode-editor-background);
      overflow: hidden;
    }
    #pdf-container {
      width: 100vw;
      height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    iframe, embed, object {
      width: 100%;
      height: 100%;
      border: none;
    }
    .message {
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: 14px;
      text-align: center;
      padding: 20px;
    }
    .toolbar {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 36px;
      background: var(--vscode-titleBar-activeBackground);
      display: flex;
      align-items: center;
      padding: 0 10px;
      gap: 8px;
      z-index: 100;
    }
    .toolbar button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 4px 10px;
      cursor: pointer;
      border-radius: 2px;
      font-size: 12px;
    }
    .toolbar button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    #pdf-frame {
      margin-top: 36px;
      width: 100%;
      height: calc(100vh - 36px);
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="btn-refresh" title="Refresh">Refresh</button>
    <button id="btn-zoom-in" title="Zoom In">+</button>
    <button id="btn-zoom-out" title="Zoom Out">-</button>
    <span id="zoom-level" style="color: var(--vscode-foreground); font-size: 12px;">100%</span>
  </div>
  <div id="pdf-container">
    <embed id="pdf-frame" src="${pdfUri}" type="application/pdf" />
  </div>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    let currentZoom = 100;

    document.getElementById('btn-refresh').addEventListener('click', () => {
      const frame = document.getElementById('pdf-frame');
      const src = frame.src;
      frame.src = '';
      setTimeout(() => { frame.src = src + '?t=' + Date.now(); }, 100);
    });

    document.getElementById('btn-zoom-in').addEventListener('click', () => {
      currentZoom = Math.min(currentZoom + 10, 300);
      applyZoom();
    });

    document.getElementById('btn-zoom-out').addEventListener('click', () => {
      currentZoom = Math.max(currentZoom - 10, 30);
      applyZoom();
    });

    function applyZoom() {
      const frame = document.getElementById('pdf-frame');
      frame.style.transform = 'scale(' + (currentZoom / 100) + ')';
      frame.style.transformOrigin = 'top left';
      frame.style.width = (100 / (currentZoom / 100)) + '%';
      frame.style.height = 'calc(' + (100 / (currentZoom / 100)) + 'vh - 36px)';
      document.getElementById('zoom-level').textContent = currentZoom + '%';
    }

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'refresh') {
        const frame = document.getElementById('pdf-frame');
        frame.src = message.pdfUri + '?t=' + Date.now();
      }
    });
  </script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
