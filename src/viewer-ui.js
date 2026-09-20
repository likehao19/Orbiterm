export function renderViewerUi() {
  document.body.innerHTML = `
    <main id="viewerApp" class="viewer-shell">
      <header class="viewer-head" data-tauri-drag-region>
        <div class="viewer-identity" data-tauri-drag-region><img id="appIcon" alt="" /><span data-tauri-drag-region><strong id="fileName">远程文件</strong><small id="filePath"></small></span></div>
        <div class="viewer-actions">
          <div class="viewer-tools">
            <button id="toggleEdit" class="viewer-tool" title="编辑" aria-label="编辑"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m10.9 2.1 3 3-8 8H3v-2.9l7.9-8.1Zm-6.4 8.7v.7h.8l6.5-6.4-.9-.9-6.4 6.6Z" fill="currentColor"/></svg></button>
            <button id="toggleWrap" class="viewer-tool" title="自动换行" aria-label="自动换行"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h11v1.5H2V3Zm0 4h9a2.5 2.5 0 0 1 0 5H9.5V14L6 11.25 9.5 8.5V10H11a1 1 0 0 0 0-2H2V7Z" fill="currentColor"/></svg></button>
            <button id="openFind" class="viewer-tool" title="查找" aria-label="查找"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 2a5 5 0 1 0 3.1 8.9l3 3 1-1-3-3A5 5 0 0 0 7 2Zm0 1.5A3.5 3.5 0 1 1 7 10a3.5 3.5 0 0 1 0-7Z" fill="currentColor"/></svg></button>
            <button id="toggleLines" class="viewer-tool active" title="隐藏行号" aria-label="隐藏行号"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3.25h2v1.5H2v-1.5Zm4 0h8v1.5H6v-1.5ZM2 7.25h2v1.5H2v-1.5Zm4 0h8v1.5H6v-1.5ZM2 11.25h2v1.5H2v-1.5Zm4 0h8v1.5H6v-1.5Z" fill="currentColor"/></svg></button>
            <button id="refreshFile" class="viewer-tool" title="刷新" aria-label="刷新"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 5.1A5.7 5.7 0 1 0 13.5 10h-1.7A4.1 4.1 0 1 1 12 6.2H9.7V4.7h4.8v4.8H13V7.2l.2-2.1Z" fill="currentColor"/></svg></button>
          </div>
          <div class="viewer-window-actions">
            <button id="minimizeWindow" class="wc-btn" title="最小化" aria-label="最小化"><svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="5.5" width="10" height="1" fill="currentColor"/></svg></button>
            <button id="toggleMaximize" class="wc-btn wc-maximize" title="最大化" aria-label="最大化"><svg class="maximize-glyph" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg><svg class="restore-glyph" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3h6v6H3V3Zm1 1v4h4V4H4zM5 1h6v6h-1V2H5V1z" fill="currentColor"/></svg></button>
            <button id="closeWindow" class="wc-btn wc-close" title="关闭" aria-label="关闭"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2 2 8 8m0-8-8 8" stroke="currentColor" stroke-width="1.2"/></svg></button>
          </div>
        </div>
      </header>
      <section id="findBar" class="find-bar hidden"><input id="findInput" placeholder="查找内容" /><small id="findCount"></small><button id="findPrevious" title="上一个">↑</button><button id="findNext" title="下一个">↓</button><button id="closeFind" title="关闭">×</button></section>
      <section class="editor-area"><pre id="lineNumbers"></pre><textarea id="editor" readonly spellcheck="false" wrap="off"></textarea><div id="loading" class="loading"><i></i><span id="loadingText">正在读取远程文件…</span></div></section>
      <footer><span id="encoding">—</span><span id="fileSize">—</span><span id="status">只读预览</span><button id="loadMore" class="secondary hidden">继续加载</button><button id="saveFile" disabled>保存到远端</button></footer>
      <div id="confirmClose" class="viewer-confirm hidden" role="dialog" aria-modal="false" aria-labelledby="confirmCloseTitle"><section><header><strong id="confirmCloseTitle">放弃修改</strong></header><div><p id="confirmCloseMessage">文件有未保存的修改，确定放弃吗？</p><footer><button id="keepEditing">继续编辑</button><button id="discardChanges" class="primary danger">放弃并关闭</button></footer></div></section></div>
      <div id="toast" class="viewer-toast hidden"></div>
    </main>`;
}
