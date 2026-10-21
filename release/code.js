"use strict";
(() => {
  // src/lib/messages.ts
  var SLIDE_W = 1920;
  var SLIDE_H = 1080;

  // src/code.ts
  var UI_WIDTH = 460;
  var UI_HEIGHT = 640;
  var exporting = false;
  function post(msg) {
    figma.ui.postMessage(msg);
  }
  function collectSlides() {
    let slides = [];
    try {
      slides = figma.getSlideGrid().reduce((acc, row) => acc.concat(row), []);
    } catch {
      slides = [];
    }
    if (slides.length > 0) return slides;
    for (const top of figma.currentPage.children) {
      if (top.type !== "SLIDE_GRID") continue;
      for (const row of top.children) {
        if (row.type !== "SLIDE_ROW") continue;
        for (const node of row.children) {
          if (node.type === "SLIDE") slides.push(node);
        }
      }
    }
    return slides;
  }
  function hasVideoFill(node) {
    if (!("fills" in node)) return false;
    const fills = node.fills;
    return Array.isArray(fills) && fills.some((f) => f.type === "VIDEO");
  }
  function videoPaintOf(node) {
    const fills = node.fills;
    if (!Array.isArray(fills)) return null;
    return fills.find((f) => f.type === "VIDEO") ?? null;
  }
  function intersect(a, b) {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const r = Math.min(a.x + a.w, b.x + b.w);
    const btm = Math.min(a.y + a.h, b.y + b.h);
    if (r <= x || btm <= y) return null;
    return { x, y, w: r - x, h: btm - y };
  }
  function uniformCornerRadius(node) {
    if (!("cornerRadius" in node)) return 0;
    const r = node.cornerRadius;
    return typeof r === "number" && r > 0 ? r : 0;
  }
  function describeVideo(node, slide, paint) {
    const st = slide.absoluteTransform;
    const nt = node.absoluteTransform;
    const slideX = st[0][2];
    const slideY = st[1][2];
    const scaleX = Math.hypot(nt[0][0], nt[1][0]) || 1;
    const scaleY = Math.hypot(nt[0][1], nt[1][1]) || 1;
    const w = node.width * scaleX;
    const h = node.height * scaleY;
    const cx = nt[0][0] * node.width * 0.5 + nt[0][1] * node.height * 0.5 + nt[0][2] - slideX;
    const cy = nt[1][0] * node.width * 0.5 + nt[1][1] * node.height * 0.5 + nt[1][2] - slideY;
    const rotation = node.id === slide.id || !("rotation" in node) ? 0 : Math.round(node.rotation * 100) / 100;
    const rect = { x: cx - w / 2, y: cy - h / 2, w, h };
    let clip = { x: 0, y: 0, w: SLIDE_W, h: SLIDE_H };
    if (rotation !== 0) {
      clip = null;
    } else {
      let p = node.parent;
      while (p && p.id !== slide.id && clip) {
        if ("clipsContent" in p && p.clipsContent) {
          const box = p.absoluteBoundingBox;
          if (box) clip = intersect(clip, { x: box.x - slideX, y: box.y - slideY, w: box.width, h: box.height });
        }
        p = p.parent;
      }
      if (clip && !intersect(clip, rect)) return null;
    }
    return {
      nodeId: node.id,
      name: node.name,
      videoHash: paint.videoHash,
      x: Math.round(rect.x * 100) / 100,
      y: Math.round(rect.y * 100) / 100,
      w: Math.round(rect.w * 100) / 100,
      h: Math.round(rect.h * 100) / 100,
      rotation,
      scaleMode: paint.scaleMode,
      videoTransform: paint.scaleMode === "CROP" && paint.videoTransform ? paint.videoTransform.map((row) => Array.from(row)) : null,
      paintRotation: paint.rotation ?? 0,
      shape: node.type === "ELLIPSE" ? "ellipse" : "rect",
      cornerRadius: node.type === "ELLIPSE" ? 0 : Math.round(uniformCornerRadius(node) * scaleX),
      clip
    };
  }
  function findVideos(slide) {
    const out = [];
    if (hasVideoFill(slide)) {
      const paint = videoPaintOf(slide);
      if (paint) {
        const info = describeVideo(slide, slide, paint);
        if (info) out.push(info);
      }
    }
    for (const node of slide.findAll((n) => hasVideoFill(n))) {
      if (!node.visible) continue;
      const paint = videoPaintOf(node);
      if (!paint) continue;
      const info = describeVideo(node, slide, paint);
      if (info) out.push(info);
    }
    return out;
  }
  function speakerNotesOf(slide) {
    const notes = slide.speakerNotes;
    return typeof notes === "string" ? notes : "";
  }
  function describeSlides(slides) {
    return slides.map((s, index) => ({
      id: s.id,
      index,
      name: s.name,
      isSkipped: s.isSkippedSlide,
      hasNotes: speakerNotesOf(s).trim().length > 0,
      videos: findVideos(s)
    }));
  }
  function selectedSlideIds() {
    const ids = figma.currentPage.selection.filter((n) => n.type === "SLIDE").map((n) => n.id);
    if (ids.length > 0) return ids;
    const focused = figma.currentPage.focusedSlide;
    return focused ? [focused.id] : [];
  }
  function notesToPlainText(md) {
    return md.replace(/\r\n?/g, "\n").replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/(^|[^\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, "$1$2").replace(/(^|[^\w_])_(?!\s)(.+?)(?<!\s)_(?!\w)/g, "$1$2").replace(/~~(.+?)~~/g, "$1").replace(/^(\s*)[-*+]\s+/gm, "$1\u2022 ").trim();
  }
  async function runExport(options) {
    if (exporting) return;
    exporting = true;
    try {
      const byId = new Map(collectSlides().map((s) => [s.id, s]));
      const ordered = [];
      for (const id of options.slideIds) {
        const s = byId.get(id);
        if (s) ordered.push(s);
      }
      if (ordered.length === 0) {
        post({ type: "export-error", message: "No slides to export." });
        return;
      }
      for (let i = 0; i < ordered.length; i++) {
        const slide = ordered[i];
        const bytes = await slide.exportAsync({
          format: "PNG",
          constraint: { type: "HEIGHT", value: options.height },
          contentsOnly: true,
          useAbsoluteBounds: false
        });
        post({
          type: "slide-image",
          slideId: slide.id,
          index: i,
          name: slide.name,
          bytes,
          notes: options.includeNotes ? notesToPlainText(speakerNotesOf(slide)) : "",
          videos: findVideos(slide)
        });
      }
      post({ type: "export-done", count: ordered.length });
    } catch (err) {
      post({ type: "export-error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      exporting = false;
    }
  }
  async function sendInit() {
    const slides = collectSlides();
    const info = describeSlides(slides);
    const thumbnails = {};
    for (const s of info) {
      if (s.videos.length === 0) continue;
      const node = slides[s.index];
      try {
        thumbnails[s.id] = await node.exportAsync({ format: "JPG", constraint: { type: "WIDTH", value: 320 } });
      } catch {
      }
    }
    post({ type: "init", deckName: figma.root.name, slides: info, selectedIds: selectedSlideIds(), thumbnails });
  }
  if (figma.editorType !== "slides") {
    figma.closePlugin("Open this plugin from a Figma Slides deck.");
  } else {
    figma.showUI(__html__, { width: UI_WIDTH, height: UI_HEIGHT, themeColors: true, title: "PowerPoint Export" });
    figma.on("selectionchange", () => {
      post({ type: "selection", selectedIds: selectedSlideIds() });
    });
    figma.ui.onmessage = (msg) => {
      switch (msg.type) {
        case "ready":
          void sendInit();
          break;
        case "export":
          void runExport(msg.options);
          break;
        case "notify":
          figma.notify(msg.message, { error: msg.error === true });
          break;
        case "close":
          figma.closePlugin();
          break;
      }
    };
  }
})();
