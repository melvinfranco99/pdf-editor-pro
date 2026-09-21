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
  let currentTextWeight = 0;
  let currentDrawOpacity = 1;
  let currentHighlightOpacity = 0.4;
  let currentTextOpacity = 1;
  let currentEraseStrength = 1;

  let isPointerDown = false;
  let currentStroke = null;
  let lastCanvasPoint = null;
  let autoDirection = null;
  let autoRAF = null;
  let activeTextEditor = null;
  let editingIndex = -1;
  let moveDrag = null;
  let selectedSignatureIndex = -1;

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
  const weightRange = document.getElementById('weight-range');
  const opacityLabel = document.getElementById('opacity-label');
  const opacityRange = document.getElementById('opacity-range');
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

  // Signature modal refs
  const signatureModal = document.getElementById('signature-modal');
  const sigCloseBtn = document.getElementById('sig-close');
  const sigGallery = document.getElementById('sig-gallery');
  const sigGalleryEmpty = document.getElementById('sig-gallery-empty');
  const sigPad = document.getElementById('sig-pad');
  const sigPadClearBtn = document.getElementById('sig-pad-clear');
  const sigPadSaveBtn = document.getElementById('sig-pad-save');
  const sigNameInput = document.getElementById('sig-name');
  const sigLastnameInput = document.getElementById('sig-lastname');
  const sigStylePicker = document.getElementById('sig-style-picker');
  const sigAutoPreview = document.getElementById('sig-auto-preview');
  const sigAutoSaveBtn = document.getElementById('sig-auto-save');

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
    editingIndex = -1;
    selectedSignatureIndex = -1;
    redrawAnnotations();
    updateHistoryButtons();
  }

  function redo() {
    if (isPointerDown) return;
    const page = pages.find((p) => p.id === currentPageId);
    if (!page || !page.redoStack.length) return;
    page.undoStack.push(snapshotAnnotations(page));
    page.annotations = page.redoStack.pop();
    editingIndex = -1;
    selectedSignatureIndex = -1;
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
  function textStampOffsets(weight) {
    if (!weight || weight <= 0.02) return [{ dx: 0, dy: 0 }];
    const pts = [{ dx: 0, dy: 0 }];
    const n = 6;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push({ dx: Math.cos(a) * weight, dy: Math.sin(a) * weight });
    }
    return pts;
  }

  function drawAnnotation(ctx, ann, viewport, scale) {
    if (ann.type === 'text') {
      ctx.save();
      ctx.globalAlpha = ann.opacity != null ? ann.opacity : 1;
      ctx.fillStyle = ann.color;
      ctx.font = `${ann.size * scale}px Helvetica, Arial, sans-serif`;
      ctx.textBaseline = 'alphabetic';
      const stamps = textStampOffsets(ann.weight);
      ann.text.split('\n').forEach((line, i) => {
        const baseY = ann.topY - ann.size * 0.8 - i * ann.size * 1.15;
        for (const s of stamps) {
          const pt = pdfToCanvas(viewport, { x: ann.x + s.dx, y: baseY + s.dy });
          ctx.fillText(line, pt.x, pt.y);
        }
      });
      ctx.restore();
      return;
    }

    if (ann.type === 'signature') {
      const img = preloadSignatureImage(ann.dataUrl);
      if (!img.complete || !img.naturalWidth) {
        img.addEventListener('load', () => redrawAnnotations(), { once: true });
        return;
      }
      const p0 = pdfToCanvas(viewport, { x: ann.x, y: ann.topY });
      const p1 = pdfToCanvas(viewport, { x: ann.x + ann.width, y: ann.topY - ann.height });
      ctx.save();
      ctx.globalAlpha = ann.opacity != null ? ann.opacity : 1;
      ctx.drawImage(
        img,
        Math.min(p0.x, p1.x), Math.min(p0.y, p1.y),
        Math.abs(p1.x - p0.x), Math.abs(p1.y - p0.y)
      );
      ctx.restore();
      return;
    }

    if (!ann.points || ann.points.length < 2) return;
    ctx.save();
    ctx.strokeStyle = ann.color;
    ctx.lineWidth = ann.width * scale;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.globalAlpha = ann.opacity != null ? ann.opacity : (ann.type === 'highlight' ? 0.4 : 1);
    if (ann.type === 'highlight') ctx.globalCompositeOperation = 'multiply';
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

  function drawSelectionBox(ctx, ann, viewport) {
    const p0 = pdfToCanvas(viewport, { x: ann.x, y: ann.topY });
    const p1 = pdfToCanvas(viewport, { x: ann.x + ann.width, y: ann.topY - ann.height });
    ctx.save();
    ctx.strokeStyle = '#4338ca';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(
      Math.min(p0.x, p1.x), Math.min(p0.y, p1.y),
      Math.abs(p1.x - p0.x), Math.abs(p1.y - p0.y)
    );
    ctx.restore();
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
    selectedSignatureIndex = -1;
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
    syncToolUI();
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
    if (selectedSignatureIndex !== -1) {
      const ann = page.annotations[selectedSignatureIndex];
      if (ann) drawSelectionBox(annotCtx, ann, currentViewport);
    }
  }

  async function setZoom(z) {
    zoom = Math.max(0.25, Math.min(z, 5));
    await renderEditorCanvas();
  }

  // ---------------- Pointer (draw / highlight / move) ----------------
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
      if (!page) return;
      const idx = findMovableAt(page, pdfPt);
      if (idx === -1) {
        if (selectedSignatureIndex !== -1) {
          selectedSignatureIndex = -1;
          syncToolUI();
          redrawAnnotations();
        }
        return;
      }
      e.preventDefault();
      annotCanvas.setPointerCapture(e.pointerId);
      isPointerDown = true;
      const ann = page.annotations[idx];
      moveDrag = { page, idx, startPdfPt: pdfPt, origX: ann.x, origTopY: ann.topY, moved: false };
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
    currentStroke = {
      type: currentTool,
      color: currentColor,
      width: currentWidth,
      opacity: currentTool === 'highlight' ? currentHighlightOpacity : currentDrawOpacity,
      points: [pdfPt],
    };
    lastCanvasPoint = canvasPt;
    redrawAnnotations();
  }

  function onPointerMove(e) {
    if (!isPointerDown) return;
    const canvasPt = getCanvasPoint(e);

    if (moveDrag) {
      const pdfPt = clampToPage(canvasToPdf(currentViewport, canvasPt));
      const dx = pdfPt.x - moveDrag.startPdfPt.x;
      const dy = pdfPt.y - moveDrag.startPdfPt.y;
      if (!moveDrag.moved && Math.hypot(dx, dy) < 3) return;
      if (!moveDrag.moved) {
        moveDrag.moved = true;
        pushHistory(moveDrag.page);
      }
      const ann = moveDrag.page.annotations[moveDrag.idx];
      ann.x = moveDrag.origX + dx;
      ann.topY = moveDrag.origTopY + dy;
      redrawAnnotations();
      return;
    }

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

    if (moveDrag) {
      const ann = moveDrag.page.annotations[moveDrag.idx];
      if (!moveDrag.moved) {
        if (ann.type === 'text') editExistingText(moveDrag.page, moveDrag.idx);
        else if (ann.type === 'signature') selectSignatureAnnotation(moveDrag.page, moveDrag.idx);
      } else if (ann.type === 'signature') {
        selectSignatureAnnotation(moveDrag.page, moveDrag.idx);
      } else {
        redrawAnnotations();
      }
      moveDrag = null;
      return;
    }

    if (currentStroke) {
      if (currentStroke.points.length === 1) {
        const p = currentStroke.points[0];
        currentStroke.points.push({ x: p.x + 0.3, y: p.y }); // visible dot on a plain click
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

  // Hover feedback for the select tool (shows a "move" cursor over movable items)
  annotCanvas.addEventListener('pointermove', (e) => {
    if (isPointerDown || currentTool !== 'select') return;
    const page = pages.find((p) => p.id === currentPageId);
    if (!page || !currentViewport) return;
    const pdfPt = clampToPage(canvasToPdf(currentViewport, getCanvasPoint(e)));
    annotCanvas.style.cursor = findMovableAt(page, pdfPt) !== -1 ? 'move' : 'default';
  });

  // ---------------- Hit-testing (eraser + click-to-edit/move) ----------------
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

  function hitTestSignature(ann, pt, pad) {
    const left = Math.min(ann.x, ann.x + ann.width) - pad;
    const right = Math.max(ann.x, ann.x + ann.width) + pad;
    const top = Math.max(ann.topY, ann.topY - ann.height) + pad;
    const bottom = Math.min(ann.topY, ann.topY - ann.height) - pad;
    return pt.x >= left && pt.x <= right && pt.y <= top && pt.y >= bottom;
  }

  function hitTestAnnotation(ann, pt, radius) {
    if (ann.type === 'text') return hitTestText(ann, pt, radius * 0.5);
    if (ann.type === 'signature') return hitTestSignature(ann, pt, radius * 0.3);
    if (!ann.points || ann.points.length < 2) return false;
    const thresh = radius + ann.width / 2;
    for (let i = 1; i < ann.points.length; i++) {
      if (distToSegment(pt, ann.points[i - 1], ann.points[i]) <= thresh) return true;
    }
    return false;
  }

  function findMovableAt(page, pt) {
    for (let i = page.annotations.length - 1; i >= 0; i--) {
      const ann = page.annotations[i];
      if (ann.type === 'text' && hitTestText(ann, pt, 3)) return i;
      if (ann.type === 'signature' && hitTestSignature(ann, pt, 2)) return i;
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
    const ann = page.annotations[idx];
    const curOpacity = ann.opacity != null ? ann.opacity : (ann.type === 'highlight' ? 0.4 : 1);
    const remaining = curOpacity - currentEraseStrength;
    if (currentEraseStrength >= 0.999 || remaining <= 0.03) {
      page.annotations.splice(idx, 1);
      if (idx === selectedSignatureIndex) selectedSignatureIndex = -1;
      else if (idx < selectedSignatureIndex) selectedSignatureIndex -= 1;
      if (idx === editingIndex) editingIndex = -1;
    } else {
      ann.opacity = remaining;
    }
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
    currentTextWeight = ann.weight || 0;
    currentTextOpacity = ann.opacity != null ? ann.opacity : 1;
    currentColor = ann.color;
    customColor.value = ann.color;
    document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', s.dataset.color === ann.color));
    editingIndex = idx;
    selectedSignatureIndex = -1;
    syncToolUI();
    redrawAnnotations();
    const canvasPt = pdfToCanvas(currentViewport, { x: ann.x, y: ann.topY });
    startTextInput(canvasPt, { x: ann.x, y: ann.topY }, { editIndex: idx, existingText: ann.text });
  }

  const SAFE_BLUR_TARGETS = () => [sizeRange, weightRange, opacityRange];

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
    ta.style.opacity = currentTextOpacity;
    if (currentTextWeight > 0.05) ta.style.webkitTextStroke = (currentTextWeight * currentScale) + 'px ' + currentColor;
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
        syncToolUI();
        if (!commit) { redrawAnnotations(); return; }
        pushHistory(page);
        if (text.trim()) {
          page.annotations[editing.editIndex] = {
            type: 'text', x: pdfPt.x, topY: pdfPt.y, text, color: currentColor,
            size: currentTextSize, weight: currentTextWeight, opacity: currentTextOpacity,
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
          type: 'text', x: pdfPt.x, topY: pdfPt.y, text, color: currentColor,
          size: currentTextSize, weight: currentTextWeight, opacity: currentTextOpacity,
        });
        redrawAnnotations();
      }
    };
    ta.addEventListener('blur', (e) => {
      if (SAFE_BLUR_TARGETS().includes(e.relatedTarget)) return; // adjusting a slider shouldn't close the editor
      finish(true);
    });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') finish(false);
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
    });
  }

  function updateActiveTextareaFontSize() {
    if (activeTextEditor) activeTextEditor.style.fontSize = currentTextSize * currentScale + 'px';
  }
  function updateActiveTextareaOpacity() {
    if (activeTextEditor) activeTextEditor.style.opacity = currentTextOpacity;
  }
  function updateActiveTextareaWeight() {
    if (!activeTextEditor) return;
    activeTextEditor.style.webkitTextStroke =
      currentTextWeight > 0.05 ? (currentTextWeight * currentScale) + 'px ' + currentColor : '';
  }

  // ---------------- Undo / redo / clear ----------------
  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);
  clearPageBtn.addEventListener('click', () => {
    const page = pages.find((p) => p.id === currentPageId);
    if (page && page.annotations.length && confirm('¿Borrar todas las anotaciones de esta página?')) {
      pushHistory(page);
      page.annotations = [];
      editingIndex = -1;
      selectedSignatureIndex = -1;
      redrawAnnotations();
    }
  });

  // ---------------- Tool / color / size / weight / opacity UI ----------------
  function setTool(name) {
    document.querySelectorAll('.tool-btn').forEach((b) => b.classList.toggle('active', b.dataset.tool === name));
    currentTool = name;
    annotCanvas.style.cursor = name === 'select' ? 'default' : name === 'erase' ? 'cell' : 'crosshair';
    syncToolUI();
  }

  document.querySelectorAll('.tool-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tool === 'signature') { openSignatureModal(); return; }
      selectedSignatureIndex = -1;
      setTool(btn.dataset.tool);
      redrawAnnotations();
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

  function getContext() {
    if (editingIndex !== -1 || currentTool === 'text') return 'text';
    if (selectedSignatureIndex !== -1) return 'signature';
    if (currentTool === 'draw') return 'draw';
    if (currentTool === 'highlight') return 'highlight';
    if (currentTool === 'erase') return 'erase';
    return 'none';
  }

  function getSelectedSignature() {
    const page = pages.find((p) => p.id === currentPageId);
    return page ? page.annotations[selectedSignatureIndex] : null;
  }

  sizeRange.addEventListener('input', () => {
    const ctx = getContext();
    const v = Number(sizeRange.value);
    if (ctx === 'text') {
      currentTextSize = v;
      updateActiveTextareaFontSize();
    } else if (ctx === 'signature') {
      const ann = getSelectedSignature();
      if (ann) {
        const aspect = ann.height / ann.width;
        ann.width = v;
        ann.height = v * aspect;
        redrawAnnotations();
      }
    } else {
      currentWidth = v;
    }
  });

  weightRange.addEventListener('input', () => {
    currentTextWeight = Number(weightRange.value);
    updateActiveTextareaWeight();
  });

  opacityRange.addEventListener('input', () => {
    const ctx = getContext();
    const v = Number(opacityRange.value) / 100;
    if (ctx === 'draw') currentDrawOpacity = v;
    else if (ctx === 'highlight') currentHighlightOpacity = v;
    else if (ctx === 'erase') currentEraseStrength = v;
    else if (ctx === 'text') { currentTextOpacity = v; updateActiveTextareaOpacity(); }
    else if (ctx === 'signature') {
      const ann = getSelectedSignature();
      if (ann) { ann.opacity = v; redrawAnnotations(); }
    }
  });

  [sizeRange, weightRange, opacityRange].forEach((el) => {
    el.addEventListener('change', () => {
      if (activeTextEditor) activeTextEditor.focus(); // resume typing after releasing a slider
    });
  });

  const TOOL_HINTS = {
    select: '💡 Arrastra un texto o una firma para moverlo. Haz clic (sin arrastrar) para editarlo o redimensionarlo con los controles de arriba. <strong>Ctrl+Z</strong> deshace, <strong>Ctrl+Y</strong> rehace.',
    draw: '✏️ Dibuja a mano alzada arrastrando el ratón. Cambia color, grosor y transparencia arriba.',
    highlight: '💡 Truco: con el resaltador, haz <strong>clic y mantenlo pulsado</strong>, luego pulsa <strong>Ctrl + flecha</strong> (←→↑↓) para trazar una línea recta y calmada en esa dirección mientras el botón siga presionado. Ajusta su transparencia arriba.',
    text: '🔤 Haz clic donde quieras escribir. Ajusta tamaño, grosor y transparencia arriba, antes o durante la escritura.',
    erase: '🧽 Haz clic o arrastra sobre un trazo, resaltado, texto o firma para borrarlo. Baja la "Intensidad" para un borrado suave (progresivo).',
  };

  function syncToolUI() {
    toolHint.innerHTML = TOOL_HINTS[currentTool] || '';
    const ctx = getContext();

    if (ctx === 'text') {
      sizeLabel.textContent = 'Tamaño texto';
      sizeRange.min = 8; sizeRange.max = 60; sizeRange.step = 1;
      sizeRange.value = currentTextSize;
      sizeRange.disabled = false;
    } else if (ctx === 'signature') {
      const ann = getSelectedSignature();
      sizeLabel.textContent = 'Tamaño firma';
      sizeRange.min = 30; sizeRange.max = 500; sizeRange.step = 1;
      sizeRange.value = ann ? Math.round(ann.width) : 150;
      sizeRange.disabled = false;
    } else if (ctx === 'draw' || ctx === 'highlight' || ctx === 'erase') {
      sizeLabel.textContent = ctx === 'erase' ? 'Radio borrado' : 'Grosor';
      sizeRange.min = 1; sizeRange.max = 40; sizeRange.step = 1;
      sizeRange.value = currentWidth;
      sizeRange.disabled = false;
    } else {
      sizeLabel.textContent = 'Grosor';
      sizeRange.value = currentWidth;
      sizeRange.disabled = true;
    }

    weightRange.disabled = ctx !== 'text';
    if (ctx === 'text') weightRange.value = currentTextWeight;

    opacityRange.disabled = ctx === 'none';
    if (ctx === 'draw') { opacityLabel.textContent = 'Transparencia'; opacityRange.value = Math.round(currentDrawOpacity * 100); }
    else if (ctx === 'highlight') { opacityLabel.textContent = 'Transparencia'; opacityRange.value = Math.round(currentHighlightOpacity * 100); }
    else if (ctx === 'text') { opacityLabel.textContent = 'Transparencia'; opacityRange.value = Math.round(currentTextOpacity * 100); }
    else if (ctx === 'erase') { opacityLabel.textContent = 'Intensidad'; opacityRange.value = Math.round(currentEraseStrength * 100); }
    else if (ctx === 'signature') {
      const ann = getSelectedSignature();
      opacityLabel.textContent = 'Transparencia';
      opacityRange.value = Math.round((ann && ann.opacity != null ? ann.opacity : 1) * 100);
    } else {
      opacityLabel.textContent = 'Transparencia';
    }
  }

  function selectSignatureAnnotation(page, idx) {
    selectedSignatureIndex = idx;
    editingIndex = -1;
    syncToolUI();
    redrawAnnotations();
  }

  // ---------------- Zoom ----------------
  zoomInBtn.addEventListener('click', () => setZoom(zoom * 1.2));
  zoomOutBtn.addEventListener('click', () => setZoom(zoom / 1.2));

  // ---------------- Editor open/close wiring ----------------
  editorClose.addEventListener('click', closeEditor);
  window.addEventListener('keydown', (e) => {
    if (editor.classList.contains('hidden') || activeTextEditor) return;
    if (e.key === 'Escape') {
      if (!signatureModal.classList.contains('hidden')) { closeSignatureModal(); return; }
      closeEditor();
      return;
    }
    if (!signatureModal.classList.contains('hidden')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
  });

  // ================= Signatures =================
  const SIGNATURES_KEY = 'pdf-editor-pro:signatures';
  let savedSignatures = [];
  const signatureImageCache = new Map(); // dataUrl -> HTMLImageElement

  function preloadSignatureImage(dataUrl) {
    let img = signatureImageCache.get(dataUrl);
    if (!img) {
      img = new Image();
      img.src = dataUrl;
      signatureImageCache.set(dataUrl, img);
    }
    return img;
  }

  function loadSignatures() {
    try {
      const raw = localStorage.getItem(SIGNATURES_KEY);
      savedSignatures = raw ? JSON.parse(raw) : [];
    } catch (err) {
      savedSignatures = [];
    }
    savedSignatures.forEach((s) => preloadSignatureImage(s.dataUrl));
  }

  function persistSignatures() {
    try {
      localStorage.setItem(SIGNATURES_KEY, JSON.stringify(savedSignatures));
    } catch (err) {
      showToast('No se pudieron guardar las firmas en este navegador (almacenamiento lleno).');
    }
  }

  function saveSignature({ label, dataUrl, w, h }) {
    const sig = { id: uid('sig'), label: label || 'Firma', dataUrl, w, h };
    savedSignatures.push(sig);
    preloadSignatureImage(dataUrl);
    persistSignatures();
    renderSigGallery();
  }

  function deleteSignature(id) {
    savedSignatures = savedSignatures.filter((s) => s.id !== id);
    persistSignatures();
    renderSigGallery();
  }

  function renderSigGallery() {
    sigGallery.innerHTML = '';
    sigGalleryEmpty.classList.toggle('hidden', savedSignatures.length > 0);
    for (const sig of savedSignatures) {
      const card = document.createElement('div');
      card.className = 'sig-card';

      const img = document.createElement('img');
      img.src = sig.dataUrl;
      img.alt = sig.label;
      card.appendChild(img);

      const label = document.createElement('div');
      label.className = 'sig-card-label';
      label.textContent = sig.label;
      card.appendChild(label);

      const actions = document.createElement('div');
      actions.className = 'sig-card-actions';

      const insertBtn = document.createElement('button');
      insertBtn.className = 'btn btn-primary';
      insertBtn.textContent = 'Insertar';
      insertBtn.disabled = !currentPageId;
      insertBtn.title = currentPageId ? 'Insertar en la página actual' : 'Abre una página para insertar';
      insertBtn.addEventListener('click', () => insertSignature(sig));
      actions.appendChild(insertBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'icon-btn danger';
      delBtn.title = 'Eliminar firma guardada';
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', () => {
        if (confirm('¿Eliminar esta firma guardada?')) deleteSignature(sig.id);
      });
      actions.appendChild(delBtn);

      card.appendChild(actions);
      sigGallery.appendChild(card);
    }
  }

  function insertSignature(sig) {
    const page = pages.find((p) => p.id === currentPageId);
    if (!page || !currentPdfPage) {
      showToast('Abre una página del documento antes de insertar una firma.');
      return;
    }
    const img = preloadSignatureImage(sig.dataUrl);
    const place = () => {
      const aspect = (img.naturalWidth && img.naturalHeight) ? img.naturalWidth / img.naturalHeight : (sig.w / sig.h) || 3;
      const [x0, y0, x1, y1] = currentPdfPage.view;
      const pageW = x1 - x0, pageH = y1 - y0;
      const width = Math.min(160, pageW * 0.45);
      const height = width / aspect;
      const x = x0 + (pageW - width) / 2;
      const topY = y0 + pageH * 0.35 + height;
      pushHistory(page);
      page.annotations.push({ type: 'signature', dataUrl: sig.dataUrl, x, topY, width, height, opacity: 1 });
      closeSignatureModal();
      selectedSignatureIndex = -1;
      setTool('select');
      selectSignatureAnnotation(page, page.annotations.length - 1);
      showToast('Firma insertada: arrástrala para moverla o usa el control de tamaño.');
    };
    if (img.complete && img.naturalWidth) place();
    else img.addEventListener('load', place, { once: true });
  }

  function cropCanvasToContent(canvas, padding) {
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    let minX = width, minY = height, maxX = 0, maxY = 0, found = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const alpha = data[(y * width + x) * 4 + 3];
        if (alpha > 10) {
          found = true;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (!found) return null;
    minX = Math.max(0, minX - padding);
    minY = Math.max(0, minY - padding);
    maxX = Math.min(width - 1, maxX + padding);
    maxY = Math.min(height - 1, maxY + padding);
    const w = maxX - minX + 1, h = maxY - minY + 1;
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    out.getContext('2d').drawImage(canvas, minX, minY, w, h, 0, 0, w, h);
    return out;
  }

  function dataUrlToUint8Array(dataUrl) {
    const base64 = dataUrl.split(',')[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // -- Modal open/close/tabs --
  function openSignatureModal() {
    signatureModal.classList.remove('hidden');
    switchSigView('gallery');
    renderSigGallery();
  }
  function closeSignatureModal() {
    signatureModal.classList.add('hidden');
  }
  sigCloseBtn.addEventListener('click', closeSignatureModal);
  signatureModal.addEventListener('click', (e) => {
    if (e.target === signatureModal) closeSignatureModal();
  });

  function switchSigView(view) {
    document.querySelectorAll('.modal-tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
    document.querySelectorAll('.modal-view').forEach((v) => v.classList.toggle('hidden', v.id !== `sig-view-${view}`));
    if (view === 'draw') { sigPadStrokes = []; sigPadPoints = null; redrawSigPad(); }
    if (view === 'auto') renderAutoSigPreview();
  }
  document.querySelectorAll('.modal-tab').forEach((t) => t.addEventListener('click', () => switchSigView(t.dataset.view)));

  // -- Signature pad (freehand) --
  let sigPadStrokes = [];
  let sigPadPoints = null;
  let sigPadDrawing = false;

  function getSigPadPoint(e) {
    const rect = sigPad.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (sigPad.width / rect.width),
      y: (e.clientY - rect.top) * (sigPad.height / rect.height),
    };
  }

  function redrawSigPad() {
    const ctx = sigPad.getContext('2d');
    ctx.clearRect(0, 0, sigPad.width, sigPad.height);
    ctx.strokeStyle = '#1a1a2e';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const all = sigPadPoints ? [...sigPadStrokes, sigPadPoints] : sigPadStrokes;
    for (const stroke of all) {
      if (stroke.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(stroke[0].x, stroke[0].y);
      for (let i = 1; i < stroke.length; i++) ctx.lineTo(stroke[i].x, stroke[i].y);
      ctx.stroke();
    }
  }

  sigPad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    sigPad.setPointerCapture(e.pointerId);
    sigPadPoints = [getSigPadPoint(e)];
    sigPadDrawing = true;
  });
  sigPad.addEventListener('pointermove', (e) => {
    if (!sigPadDrawing) return;
    sigPadPoints.push(getSigPadPoint(e));
    redrawSigPad();
  });
  function endSigPadStroke() {
    if (!sigPadDrawing) return;
    sigPadDrawing = false;
    if (sigPadPoints && sigPadPoints.length > 1) sigPadStrokes.push(sigPadPoints);
    sigPadPoints = null;
  }
  sigPad.addEventListener('pointerup', endSigPadStroke);
  sigPad.addEventListener('pointercancel', endSigPadStroke);

  sigPadClearBtn.addEventListener('click', () => {
    sigPadStrokes = [];
    sigPadPoints = null;
    redrawSigPad();
  });

  sigPadSaveBtn.addEventListener('click', () => {
    if (!sigPadStrokes.length) { showToast('Dibuja tu firma antes de guardar.'); return; }
    const cropped = cropCanvasToContent(sigPad, 8);
    if (!cropped) { showToast('No se detectó ningún trazo.'); return; }
    const dataUrl = cropped.toDataURL('image/png');
    saveSignature({ label: 'Firma dibujada', dataUrl, w: cropped.width, h: cropped.height });
    sigPadStrokes = [];
    sigPadPoints = null;
    redrawSigPad();
    switchSigView('gallery');
    showToast('Firma guardada ✅');
  });

  // -- Auto-generated signature (name/surname in a script font) --
  let sigSelectedFont = "'Dancing Script', cursive";

  sigStylePicker.addEventListener('click', (e) => {
    const btn = e.target.closest('.sig-style-btn');
    if (!btn) return;
    sigStylePicker.querySelectorAll('.sig-style-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    sigSelectedFont = btn.dataset.font;
    renderAutoSigPreview();
  });
  sigNameInput.addEventListener('input', renderAutoSigPreview);
  sigLastnameInput.addEventListener('input', renderAutoSigPreview);

  let sigPreviewGen = 0;
  async function renderAutoSigPreview() {
    const myGen = ++sigPreviewGen;
    const text = `${sigNameInput.value.trim()} ${sigLastnameInput.value.trim()}`.trim();
    const font = sigSelectedFont;
    const fontSize = 64;
    try { await document.fonts.load(`${fontSize}px ${font}`); } catch (err) { /* font may already be cached */ }
    if (myGen !== sigPreviewGen) return; // a newer call superseded this one; don't clobber it
    const ctx = sigAutoPreview.getContext('2d');
    ctx.clearRect(0, 0, sigAutoPreview.width, sigAutoPreview.height);
    if (!text) return;
    ctx.fillStyle = '#1a1a2e';
    ctx.font = `${fontSize}px ${font}`;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 16, sigAutoPreview.height / 2);
  }

  sigAutoSaveBtn.addEventListener('click', async () => {
    const text = `${sigNameInput.value.trim()} ${sigLastnameInput.value.trim()}`.trim();
    if (!text) { showToast('Escribe al menos tu nombre.'); return; }
    await renderAutoSigPreview();
    const cropped = cropCanvasToContent(sigAutoPreview, 10);
    if (!cropped) { showToast('No se pudo generar la firma.'); return; }
    const dataUrl = cropped.toDataURL('image/png');
    saveSignature({ label: text, dataUrl, w: cropped.width, h: cropped.height });
    switchSigView('gallery');
    showToast('Firma guardada ✅');
  });

  // ---------------- Export ----------------
  exportBtn.addEventListener('click', exportPdf);

  function buildSvgPathD(points) {
    // pdf-lib's drawSvgPath auto-flips the Y axis to match SVG conventions,
    // so we pre-negate Y to land exactly on our own PDF-space coordinates.
    let d = `M ${points[0].x} ${-points[0].y}`;
    for (let i = 1; i < points.length; i++) d += ` L ${points[i].x} ${-points[i].y}`;
    return d;
  }

  async function exportPdf() {
    if (!pages.length) return;
    exportBtn.disabled = true;
    const label = exportBtn.textContent;
    exportBtn.textContent = 'Generando…';
    try {
      const finalDoc = await PDFDocument.create();
      const font = await finalDoc.embedFont(StandardFonts.Helvetica);
      const signaturePdfImageCache = new Map(); // dataUrl -> embedded PDFImage (scoped to this export)

      for (const page of pages) {
        const src = docs[page.docId];
        const [copied] = await finalDoc.copyPages(src.pdfLibDoc, [page.pageIndex]);
        finalDoc.addPage(copied);

        for (const ann of page.annotations) {
          if (ann.type === 'text') {
            const color = rgb(...hexToRgb01(ann.color));
            const opacity = ann.opacity != null ? ann.opacity : 1;
            const stamps = textStampOffsets(ann.weight);
            ann.text.split('\n').forEach((line, i) => {
              const baseY = ann.topY - ann.size * 0.8 - i * ann.size * 1.15;
              for (const s of stamps) {
                copied.drawText(line, { x: ann.x + s.dx, y: baseY + s.dy, size: ann.size, font, color, opacity });
              }
            });
          } else if (ann.type === 'signature') {
            let pngImage = signaturePdfImageCache.get(ann.dataUrl);
            if (!pngImage) {
              pngImage = await finalDoc.embedPng(dataUrlToUint8Array(ann.dataUrl));
              signaturePdfImageCache.set(ann.dataUrl, pngImage);
            }
            copied.drawImage(pngImage, {
              x: ann.x,
              y: ann.topY - ann.height,
              width: ann.width,
              height: ann.height,
              opacity: ann.opacity != null ? ann.opacity : 1,
            });
          } else if (ann.points && ann.points.length >= 2) {
            const color = rgb(...hexToRgb01(ann.color));
            const isHi = ann.type === 'highlight';
            copied.drawSvgPath(buildSvgPathD(ann.points), {
              x: 0, y: 0,
              borderColor: color,
              borderWidth: ann.width,
              borderOpacity: ann.opacity != null ? ann.opacity : (isHi ? 0.4 : 1),
              borderLineCap: LineCapStyle.Round,
            });
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

  loadSignatures();
  updateViewState();
})();
