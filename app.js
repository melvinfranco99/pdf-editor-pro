(() => {
  'use strict';

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const { PDFDocument, rgb, StandardFonts, LineCapStyle } = PDFLib;

  // ---------------- State ----------------
  let docs = {};   // docId -> { name, pdfLibDoc, pdfjsDoc }
  let pages = [];  // working page list: { id, docId, pageIndex, annotations: [] }

  let currentPageId = null;
  let currentPdfPage = null;
  let currentViewport = null;
  let currentScale = 1;
  let fitZoom = 1;
  let zoom = 1;

  let currentTool = 'select';
  let currentColor = '#ffeb3b';
  let currentWidth = 8;
  let currentTextSize = 18;

  let isPointerDown = false;
  let currentStroke = null;
  let lastCanvasPoint = null;
  let autoDirection = null;
  let autoRAF = null;
  let activeTextEditor = null;
  let editingIndex = -1;

  const AUTO_SPEED = 140; // canvas px/sec — "recto y con calma"

  // ---------------- DOM refs ----------------
  const fileInput = document.getElementById('file-input');
  const dropzone = document.getElementById('dropzone');
  const gridView = document.getElementById('grid-view');
  const pageGrid = document.getElementById('page-grid');
  const pageCountEl = document.getElementById('page-count');
  const exportBtn = document.getElementById('export-btn');
  const resetBtn = document.getElementById('reset-btn');

  const editor = document.getElementById('editor');
  const editorClose = document.getElementById('editor-close');
  const baseCanvas = document.getElementById('base-canvas');
  const annotCanvas = document.getElementById('annotation-canvas');
  const canvasStage = document.getElementById('canvas-stage');
  const canvasWrap = document.getElementById('canvas-wrap');
  const toolHint = document.getElementById('tool-hint');
  const sizeLabel = document.getElementById('size-label');
  const sizeRange = document.getElementById('size-range');
  const customColor = document.getElementById('custom-color');
  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');
  const clearPageBtn = document.getElementById('clear-page-btn');
  const zoomInBtn = document.getElementById('zoom-in');
  const zoomOutBtn = document.getElementById('zoom-out');
  const zoomLevelEl = document.getElementById('zoom-level');
  const toast = document.getElementById('toast');

  const baseCtx = baseCanvas.getContext('2d');
  const annotCtx = annotCanvas.getContext('2d');

  // ---------------- Utilities ----------------
  function uid(prefix) {
    return prefix + '_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function showToast(msg, ms = 2800) {
    toast.textContent = msg;
    toast.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.add('hidden'), ms);
  }

  function hexToRgb01(hex) {
    const h = hex.replace('#', '');
    return [
      parseInt(h.substring(0, 2), 16) / 255,
      parseInt(h.substring(2, 4), 16) / 255,
      parseInt(h.substring(4, 6), 16) / 255,
    ];
  }

  // pdf.js viewport.transform maps PDF page-space -> canvas pixels (and already
  // accounts for the page's own /Rotate), so inverting it gives us exactly the
  // coordinate system pdf-lib expects when drawing back onto that same page.
  function invertTransform([a, b, c, d, e, f]) {
    const det = a * d - b * c;
    const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
    return [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)];
  }
  function pdfToCanvas(viewport, pt) {
    const [a, b, c, d, e, f] = viewport.transform;
    return { x: a * pt.x + c * pt.y + e, y: b * pt.x + d * pt.y + f };
  }
  function canvasToPdf(viewport, pt) {
    const [a, b, c, d, e, f] = invertTransform(viewport.transform);
    return { x: a * pt.x + c * pt.y + e, y: b * pt.x + d * pt.y + f };
  }
  function clampToPage(pt) {
    const [x0, y0, x1, y1] = currentPdfPage.view;
    return {
      x: Math.min(Math.max(pt.x, x0), x1),
      y: Math.min(Math.max(pt.y, y0), y1),
    };
  }

  // ---------------- File loading ----------------
  function hasFiles(e) {
    return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList).filter(
      (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
    );
    if (!files.length) return;
    for (const file of files) {
      try {
        await loadPdfFile(file);
      } catch (err) {
        console.error(err);
        showToast(`No se pudo cargar "${file.name}": ${err.message}`);
      }
    }
    updateViewState();
    renderGrid();
  }

  async function loadPdfFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdfLibDoc = await PDFDocument.load(bytes.slice(), { ignoreEncryption: true });
    const pdfjsDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;

    const docId = uid('doc');
    docs[docId] = { name: file.name, pdfLibDoc, pdfjsDoc };

    for (let i = 0; i < pdfjsDoc.numPages; i++) {
      pages.push({ id: uid('page'), docId, pageIndex: i, annotations: [], undoStack: [], redoStack: [] });
    }
  }

  // ---------------- Undo / redo history (per page) ----------------
  function snapshotAnnotations(page) {
    return JSON.parse(JSON.stringify(page.annotations));
  }

  function pushHistory(page) {
    page.undoStack.push(snapshotAnnotations(page));
    if (page.undoStack.length > 50) page.undoStack.shift();
    page.redoStack = [];
    updateHistoryButtons();
  }

  function undo() {
    if (isPointerDown) return;
    const page = pages.find((p) => p.id === currentPageId);
    if (!page || !page.undoStack.length) return;
    page.redoStack.push(snapshotAnnotations(page));
    page.annotations = page.undoStack.pop();
    redrawAnnotations();
    updateHistoryButtons();
  }

  function redo() {
    if (isPointerDown) return;
    const page = pages.find((p) => p.id === currentPageId);
    if (!page || !page.redoStack.length) return;
    page.undoStack.push(snapshotAnnotations(page));
    page.annotations = page.redoStack.pop();
    redrawAnnotations();
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    const page = pages.find((p) => p.id === currentPageId);
    undoBtn.disabled = !page || !page.undoStack.length;
    redoBtn.disabled = !page || !page.redoStack.length;
  }

  function updateViewState() {
    const hasPages = pages.length > 0;
    dropzone.classList.toggle('hidden', hasPages);
    gridView.classList.toggle('hidden', !hasPages);
    exportBtn.disabled = !hasPages;
    resetBtn.disabled = !hasPages;
    const nDocs = Object.keys(docs).length;
    pageCountEl.textContent = hasPages
      ? `${pages.length} página${pages.length === 1 ? '' : 's'} · ${nDocs} archivo${nDocs === 1 ? '' : 's'}`
      : '';
  }

  // ---------------- Annotation drawing (shared by thumbs + editor) ----------------
  function drawAnnotation(ctx, ann, viewport, scale) {
    if (ann.type === 'text') {
      ctx.save();
      ctx.fillStyle = ann.color;
      ctx.font = `${ann.size * scale}px Helvetica, Arial, sans-serif`;
      ctx.textBaseline = 'alphabetic';
      ann.text.split('\n').forEach((line, i) => {
        const pt = pdfToCanvas(viewport, {
          x: ann.x,
          y: ann.topY - ann.size * 0.8 - i * ann.size * 1.15,
        });
        ctx.fillText(line, pt.x, pt.y);
      });
      ctx.restore();
      return;
    }
    if (!ann.points || ann.points.length < 2) return;
    ctx.save();
    ctx.strokeStyle = ann.color;
    ctx.lineWidth = ann.width * scale;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (ann.type === 'highlight') {
      ctx.globalAlpha = 0.4;
      ctx.globalCompositeOperation = 'multiply';
    }
    ctx.beginPath();
    const p0 = pdfToCanvas(viewport, ann.points[0]);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < ann.points.length; i++) {
      const p = pdfToCanvas(viewport, ann.points[i]);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function renderAnnotationsList(ctx, list, viewport, scale) {
    for (const ann of list) drawAnnotation(ctx, ann, viewport, scale);
  }

  // ---------------- Grid rendering ----------------
  async function renderGrid() {
    pageGrid.innerHTML = '';
    for (const page of pages) {
      const card = document.createElement('div');
      card.className = 'page-card';
      card.draggable = true;
      card.dataset.pageId = page.id;

      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'page-thumb-wrap';
      const canvas = document.createElement('canvas');
      thumbWrap.appendChild(canvas);

      const numberBadge = document.createElement('div');
      numberBadge.className = 'page-number';
      thumbWrap.appendChild(numberBadge);

      if (page.annotations.length) {
        const dot = document.createElement('div');
        dot.className = 'page-annot-dot';
        thumbWrap.appendChild(dot);
      }

      const actions = document.createElement('div');
      actions.className = 'page-actions';
      actions.innerHTML =
        '<button class="icon-btn" data-action="edit" title="Editar">✏️</button>' +
        '<button class="icon-btn danger" data-action="delete" title="Eliminar página">🗑</button>';
      thumbWrap.appendChild(actions);

      const source = document.createElement('div');
      source.className = 'page-source';
      source.textContent = docs[page.docId] ? docs[page.docId].name : '';

      card.appendChild(thumbWrap);
      card.appendChild(source);
      pageGrid.appendChild(card);

      renderThumb(page, canvas);
    }
    renumberBadges();
    attachDragHandlers();
  }

  function renumberBadges() {
    pageGrid.querySelectorAll('.page-card').forEach((card, idx) => {
      const badge = card.querySelector('.page-number');
      if (badge) badge.textContent = idx + 1;
    });
  }

  async function renderThumb(page, canvas) {
    const doc = docs[page.docId];
    if (!doc) return;
    const pdfPage = await doc.pdfjsDoc.getPage(page.pageIndex + 1);
    const vp1 = pdfPage.getViewport({ scale: 1 });
    const scale = 260 / vp1.width;
    const viewport = pdfPage.getViewport({ scale });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await pdfPage.render({ canvasContext: ctx, viewport }).promise;
    renderAnnotationsList(ctx, page.annotations, viewport, scale);
  }

  // ---------------- Drag & drop reorder ----------------
  let dragSrcId = null;

  function attachDragHandlers() {
    pageGrid.querySelectorAll('.page-card').forEach((card) => {
      card.addEventListener('dragstart', () => {
        dragSrcId = card.dataset.pageId;
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        pageGrid.querySelectorAll('.page-card').forEach((c) => c.classList.remove('drag-over-target'));
      });
      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        card.classList.add('drag-over-target');
      });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over-target'));
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.classList.remove('drag-over-target');
        const targetId = card.dataset.pageId;
        if (!dragSrcId || dragSrcId === targetId) return;
        reorderPages(dragSrcId, targetId);
      });
      card.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const pageId = card.dataset.pageId;
        if (btn.dataset.action === 'edit') openEditor(pageId);
        if (btn.dataset.action === 'delete') deletePage(pageId);
      });
    });
  }

  function reorderPages(srcId, targetId) {
    const srcIdx = pages.findIndex((p) => p.id === srcId);
    const targetIdx = pages.findIndex((p) => p.id === targetId);
    if (srcIdx === -1 || targetIdx === -1) return;
    const [moved] = pages.splice(srcIdx, 1);
    pages.splice(targetIdx, 0, moved);
    renderGrid();
  }

  function deletePage(pageId) {
    const idx = pages.findIndex((p) => p.id === pageId);
    if (idx === -1) return;
    pages.splice(idx, 1);
    updateViewState();
    renderGrid();
  }

  // ---------------- Editor open/close/render ----------------
  async function openEditor(pageId) {
    const page = pages.find((p) => p.id === pageId);
    if (!page) return;
    currentPageId = pageId;
    editingIndex = -1;
    const doc = docs[page.docId];
    currentPdfPage = await doc.pdfjsDoc.getPage(page.pageIndex + 1);

    editor.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    const vp1 = currentPdfPage.getViewport({ scale: 1 });
    fitZoom = Math.max(
      0.25,
      Math.min((canvasWrap.clientWidth - 60) / vp1.width, (canvasWrap.clientHeight - 40) / vp1.height, 2.5)
    );
    zoom = fitZoom;
    await renderEditorCanvas();
    updateHighlightHint();
    updateHistoryButtons();
  }

  function closeEditor() {
    if (activeTextEditor) return; // finish text edit first
    editor.classList.add('hidden');
    document.body.style.overflow = '';
    currentPageId = null;
    currentPdfPage = null;
    renderGrid();
  }

  async function renderEditorCanvas() {
    currentViewport = currentPdfPage.getViewport({ scale: zoom });
    currentScale = zoom;
    baseCanvas.width = annotCanvas.width = Math.round(currentViewport.width);
    baseCanvas.height = annotCanvas.height = Math.round(currentViewport.height);
    canvasStage.style.width = baseCanvas.width + 'px';
    canvasStage.style.height = baseCanvas.height + 'px';
    await currentPdfPage.render({ canvasContext: baseCtx, viewport: currentViewport }).promise;
    redrawAnnotations();
    zoomLevelEl.textContent = Math.round((zoom / fitZoom) * 100) + '%';
  }

  function redrawAnnotations() {
    annotCtx.clearRect(0, 0, annotCanvas.width, annotCanvas.height);
    const page = pages.find((p) => p.id === currentPageId);
    if (!page) return;
    const list = editingIndex === -1 ? page.annotations : page.annotations.filter((_, i) => i !== editingIndex);
    renderAnnotationsList(annotCtx, list, currentViewport, currentScale);
    if (currentStroke) drawAnnotation(annotCtx, currentStroke, currentViewport, currentScale);
  }

  async function setZoom(z) {
    zoom = Math.max(0.25, Math.min(z, 5));
    await renderEditorCanvas();
  }

  // ---------------- Pointer (draw / highlight) ----------------
  function getCanvasPoint(e) {
    const rect = annotCanvas.getBoundingClientRect();
    const scaleX = annotCanvas.width / rect.width;
    const scaleY = annotCanvas.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  function onPointerDown(e) {
    const canvasPt = getCanvasPoint(e);
    const pdfPt = clampToPage(canvasToPdf(currentViewport, canvasPt));

    if (currentTool === 'select') {
      const page = pages.find((p) => p.id === currentPageId);
      if (page) {
        const idx = findTextAt(page, pdfPt);
        if (idx !== -1) {
          e.preventDefault();
          editExistingText(page, idx);
        }
      }
      return;
    }

    e.preventDefault();

    if (currentTool === 'text') {
      startTextInput(canvasPt, pdfPt);
      return;
    }

    if (currentTool === 'erase') {
      annotCanvas.setPointerCapture(e.pointerId);
      isPointerDown = true;
      eraseAt(pdfPt);
      return;
    }

    annotCanvas.setPointerCapture(e.pointerId);
    isPointerDown = true;
    currentStroke = { type: currentTool, color: currentColor, width: currentWidth, points: [pdfPt] };
    lastCanvasPoint = canvasPt;
    redrawAnnotations();
  }

  function onPointerMove(e) {
    if (!isPointerDown) return;
    const canvasPt = getCanvasPoint(e);

    if (currentTool === 'erase') {
      eraseAt(clampToPage(canvasToPdf(currentViewport, canvasPt)));
      return;
    }

    if (!currentStroke || autoDirection) return;
    if (lastCanvasPoint) {
      const dx = canvasPt.x - lastCanvasPoint.x, dy = canvasPt.y - lastCanvasPoint.y;
      if (Math.hypot(dx, dy) < 1.5) return;
    }
    lastCanvasPoint = canvasPt;
    currentStroke.points.push(clampToPage(canvasToPdf(currentViewport, canvasPt)));
    redrawAnnotations();
  }

  function onPointerUp() {
    if (!isPointerDown) return;
    isPointerDown = false;
    stopAutoDirection();
    if (currentStroke) {
      if (currentStroke.points.length === 1) {
        const p = currentStroke.points[0];
        currentStroke.points.push({ x: p.x + 0.05, y: p.y }); // visible dot on a plain click
      }
      const page = pages.find((p) => p.id === currentPageId);
      if (page) {
        pushHistory(page);
        page.annotations.push(currentStroke);
      }
    }
    currentStroke = null;
    lastCanvasPoint = null;
    redrawAnnotations();
  }

  // ---------------- Hit-testing (eraser + click-to-edit text) ----------------
  function distToSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function estimateTextWidth(ann) {
    annotCtx.save();
    annotCtx.font = `${ann.size}px Helvetica, Arial, sans-serif`;
    let max = 0;
    ann.text.split('\n').forEach((line) => { max = Math.max(max, annotCtx.measureText(line).width); });
    annotCtx.restore();
    return max;
  }

  function hitTestText(ann, pt, pad) {
    const w = estimateTextWidth(ann);
    const lines = ann.text.split('\n').length;
    const left = ann.x - pad, right = ann.x + w + pad;
    const top = ann.topY + pad;
    const bottom = ann.topY - lines * ann.size * 1.15 - pad;
    return pt.x >= left && pt.x <= right && pt.y <= top && pt.y >= bottom;
  }

  function hitTestAnnotation(ann, pt, radius) {
    if (ann.type === 'text') return hitTestText(ann, pt, radius * 0.5);
    if (!ann.points || ann.points.length < 2) return false;
    const thresh = radius + ann.width / 2;
    for (let i = 1; i < ann.points.length; i++) {
      if (distToSegment(pt, ann.points[i - 1], ann.points[i]) <= thresh) return true;
    }
    return false;
  }

  function findTextAt(page, pt) {
    for (let i = page.annotations.length - 1; i >= 0; i--) {
      const ann = page.annotations[i];
      if (ann.type === 'text' && hitTestText(ann, pt, 3)) return i;
    }
    return -1;
  }

  function eraseAt(pdfPt) {
    const page = pages.find((p) => p.id === currentPageId);
    if (!page) return;
    const radius = Math.max(currentWidth, 10);
    const idx = page.annotations.findIndex((ann) => hitTestAnnotation(ann, pdfPt, radius));
    if (idx === -1) return;
    pushHistory(page);
    page.annotations.splice(idx, 1);
    redrawAnnotations();
  }

  annotCanvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  // ---------------- Ctrl + Arrow: straight, calm auto-highlight ----------------
  function startAutoDirection(dir) {
    if (autoDirection === dir) return;
    autoDirection = dir;
    let lastTime = performance.now();
    if (autoRAF) cancelAnimationFrame(autoRAF);
    const step = (now) => {
      if (!isPointerDown || autoDirection !== dir || !currentStroke) {
        autoRAF = null;
        return;
      }
      const dist = AUTO_SPEED * ((now - lastTime) / 1000);
      lastTime = now;
      const dx = dir === 'left' ? -dist : dir === 'right' ? dist : 0;
      const dy = dir === 'up' ? -dist : dir === 'down' ? dist : 0;
      const last = currentStroke.points[currentStroke.points.length - 1];
      const lastCanvas = pdfToCanvas(currentViewport, last);
      const newCanvas = { x: lastCanvas.x + dx, y: lastCanvas.y + dy };
      currentStroke.points.push(clampToPage(canvasToPdf(currentViewport, newCanvas)));
      lastCanvasPoint = newCanvas;
      redrawAnnotations();
      autoRAF = requestAnimationFrame(step);
    };
    autoRAF = requestAnimationFrame(step);
  }

  function stopAutoDirection() {
    autoDirection = null;
    if (autoRAF) {
      cancelAnimationFrame(autoRAF);
      autoRAF = null;
    }
  }

  const ARROW_DIR = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

  window.addEventListener('keydown', (e) => {
    if (!isPointerDown || currentTool !== 'highlight' || !e.ctrlKey) return;
    const dir = ARROW_DIR[e.key];
    if (!dir) return;
    e.preventDefault();
    startAutoDirection(dir);
  });
  window.addEventListener('keyup', (e) => {
    const dir = ARROW_DIR[e.key];
    if (dir && autoDirection === dir) stopAutoDirection();
    if (e.key === 'Control') stopAutoDirection();
  });

  // ---------------- Text tool ----------------
  function editExistingText(page, idx) {
    const ann = page.annotations[idx];
    currentTextSize = ann.size;
    sizeLabel.textContent = 'Tamaño texto';
    sizeRange.min = 8;
    sizeRange.max = 60;
    sizeRange.value = ann.size;
    currentColor = ann.color;
    customColor.value = ann.color;
    document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', s.dataset.color === ann.color));
    editingIndex = idx;
    redrawAnnotations();
    const canvasPt = pdfToCanvas(currentViewport, { x: ann.x, y: ann.topY });
    startTextInput(canvasPt, { x: ann.x, y: ann.topY }, { editIndex: idx, existingText: ann.text });
  }

  function startTextInput(canvasPt, pdfPt, editing) {
    if (activeTextEditor) return;
    const ta = document.createElement('textarea');
    ta.className = 'text-input-overlay';
    ta.rows = 1;
    ta.spellcheck = false;
    if (editing) ta.value = editing.existingText;
    const fontSizeCanvas = currentTextSize * currentScale;
    ta.style.left = canvasPt.x + 'px';
    ta.style.top = canvasPt.y - fontSizeCanvas + 'px';
    ta.style.fontSize = fontSizeCanvas + 'px';
    ta.style.color = currentColor;
    canvasStage.appendChild(ta);
    activeTextEditor = ta;
    ta.focus();
    if (editing) ta.setSelectionRange(ta.value.length, ta.value.length);

    let finished = false;
    const finish = (commit) => {
      if (finished) return;
      finished = true;
      const text = ta.value;
      ta.remove();
      activeTextEditor = null;
      const page = pages.find((p) => p.id === currentPageId);
      if (!page) return;
      if (editing) {
        editingIndex = -1;
        updateHighlightHint();
        if (!commit) { redrawAnnotations(); return; }
        pushHistory(page);
        if (text.trim()) {
          page.annotations[editing.editIndex] = {
            type: 'text', x: pdfPt.x, topY: pdfPt.y, text, color: currentColor, size: currentTextSize,
          };
        } else {
          page.annotations.splice(editing.editIndex, 1);
        }
        redrawAnnotations();
        return;
      }
      if (commit && text.trim()) {
        pushHistory(page);
        page.annotations.push({
          type: 'text', x: pdfPt.x, topY: pdfPt.y, text, color: currentColor, size: currentTextSize,
        });
        redrawAnnotations();
      }
    };
    ta.addEventListener('blur', (e) => {
      if (e.relatedTarget === sizeRange) return; // adjusting the size slider shouldn't close the editor
      finish(true);
    });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') finish(false);
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
    });
  }

  function updateActiveTextareaFontSize() {
    if (!activeTextEditor) return;
    activeTextEditor.style.fontSize = currentTextSize * currentScale + 'px';
  }

  // ---------------- Undo / redo / clear ----------------
  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);
  clearPageBtn.addEventListener('click', () => {
    const page = pages.find((p) => p.id === currentPageId);
    if (page && page.annotations.length && confirm('¿Borrar todas las anotaciones de esta página?')) {
      pushHistory(page);
      page.annotations = [];
      redrawAnnotations();
    }
  });

  // ---------------- Tool / color / width UI ----------------
  document.querySelectorAll('.tool-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tool-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentTool = btn.dataset.tool;
      annotCanvas.style.cursor = currentTool === 'select' ? 'default' : currentTool === 'erase' ? 'cell' : 'crosshair';
      updateHighlightHint();
    });
  });

  document.querySelectorAll('.swatch').forEach((sw) => {
    sw.addEventListener('click', () => {
      document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
      sw.classList.add('active');
      currentColor = sw.dataset.color;
      customColor.value = currentColor;
    });
  });
  customColor.addEventListener('input', () => {
    currentColor = customColor.value;
    document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
  });
  sizeRange.addEventListener('input', () => {
    if (currentTool === 'text' || editingIndex !== -1) {
      currentTextSize = Number(sizeRange.value);
      updateActiveTextareaFontSize();
    } else {
      currentWidth = Number(sizeRange.value);
    }
  });
  sizeRange.addEventListener('change', () => {
    if (activeTextEditor) activeTextEditor.focus(); // resume typing after releasing the slider
  });

  const TOOL_HINTS = {
    select: '💡 Haz clic sobre un texto ya insertado para editarlo y cambiar su tamaño. Usa <strong>Ctrl+Z</strong> para deshacer y <strong>Ctrl+Y</strong> para rehacer.',
    draw: '✏️ Dibuja a mano alzada arrastrando el ratón. Cambia color y grosor arriba.',
    highlight: '💡 Truco: con el resaltador, haz <strong>clic y mantenlo pulsado</strong>, luego pulsa <strong>Ctrl + flecha</strong> (←→↑↓) para trazar una línea recta y calmada en esa dirección mientras el botón siga presionado.',
    text: '🔤 Haz clic donde quieras escribir. Ajusta el tamaño con el control de arriba, antes o durante la escritura.',
    erase: '🧽 Haz clic o arrastra sobre un trazo, resaltado o texto para borrarlo al instante.',
  };

  function updateHighlightHint() {
    toolHint.innerHTML = TOOL_HINTS[currentTool] || '';
    if (currentTool === 'text') {
      sizeLabel.textContent = 'Tamaño texto';
      sizeRange.min = 8;
      sizeRange.max = 60;
      sizeRange.value = currentTextSize;
    } else {
      sizeLabel.textContent = 'Grosor';
      sizeRange.min = 1;
      sizeRange.max = 40;
      sizeRange.value = currentWidth;
    }
  }

  // ---------------- Zoom ----------------
  zoomInBtn.addEventListener('click', () => setZoom(zoom * 1.2));
  zoomOutBtn.addEventListener('click', () => setZoom(zoom / 1.2));

  // ---------------- Editor open/close wiring ----------------
  editorClose.addEventListener('click', closeEditor);
  window.addEventListener('keydown', (e) => {
    if (editor.classList.contains('hidden') || activeTextEditor) return;
    if (e.key === 'Escape') { closeEditor(); return; }
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
  });

  // ---------------- Export ----------------
  exportBtn.addEventListener('click', exportPdf);

  async function exportPdf() {
    if (!pages.length) return;
    exportBtn.disabled = true;
    const label = exportBtn.textContent;
    exportBtn.textContent = 'Generando…';
    try {
      const finalDoc = await PDFDocument.create();
      const font = await finalDoc.embedFont(StandardFonts.Helvetica);

      for (const page of pages) {
        const src = docs[page.docId];
        const [copied] = await finalDoc.copyPages(src.pdfLibDoc, [page.pageIndex]);
        finalDoc.addPage(copied);

        for (const ann of page.annotations) {
          const color = rgb(...hexToRgb01(ann.color));
          if (ann.type === 'text') {
            ann.text.split('\n').forEach((line, i) => {
              copied.drawText(line, {
                x: ann.x,
                y: ann.topY - ann.size * 0.8 - i * ann.size * 1.15,
                size: ann.size,
                font,
                color,
              });
            });
          } else if (ann.points && ann.points.length >= 2) {
            const isHi = ann.type === 'highlight';
            for (let i = 1; i < ann.points.length; i++) {
              copied.drawLine({
                start: ann.points[i - 1],
                end: ann.points[i],
                thickness: ann.width,
                color,
                opacity: isHi ? 0.4 : 1,
                lineCap: LineCapStyle.Round,
              });
            }
          }
        }
      }

      const bytes = await finalDoc.save();
      downloadBlob(bytes, 'documento-editado.pdf');
      showToast('PDF exportado correctamente ✅');
    } catch (err) {
      console.error(err);
      showToast('Error al exportar: ' + err.message, 4000);
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = label;
    }
  }

  function downloadBlob(bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  // ---------------- Reset ----------------
  resetBtn.addEventListener('click', () => {
    if (!confirm('¿Vaciar todo? Se perderán los documentos y anotaciones actuales.')) return;
    docs = {};
    pages = [];
    updateViewState();
    renderGrid();
  });

  // ---------------- File input / drag & drop ----------------
  fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
    fileInput.value = '';
  });

  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));

  document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    if (!editor.classList.contains('hidden')) return;
    handleFiles(e.dataTransfer.files);
  });

  window.addEventListener('beforeunload', (e) => {
    if (pages.length) { e.preventDefault(); e.returnValue = ''; }
  });

  updateViewState();
})();
