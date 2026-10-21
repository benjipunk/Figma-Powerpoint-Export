// Main thread. Has access to the Figma document; no DOM.
// Responsibilities: enumerate slides, detect videos, rasterize slides with
// exportAsync, read speaker notes, and stream everything to the UI.

import type { ExportOptions, MainToUi, Rect, SlideInfo, UiToMain, VideoInfo } from './lib/messages'
import { SLIDE_H, SLIDE_W } from './lib/messages'

const UI_WIDTH = 460
const UI_HEIGHT = 640

let exporting = false

function post(msg: MainToUi): void {
  figma.ui.postMessage(msg)
}

// ---------------------------------------------------------------------------
// Slide discovery
// ---------------------------------------------------------------------------

/**
 * Returns every slide in presentation order.
 * `figma.getSlideGrid()` is the documented API, but it has been observed to
 * return an empty grid in some runtimes, so fall back to walking the node tree
 * (SLIDE_GRID > SLIDE_ROW > SLIDE), which is the same order.
 */
function collectSlides(): SlideNode[] {
  let slides: SlideNode[] = []
  try {
    slides = figma.getSlideGrid().reduce<SlideNode[]>((acc, row) => acc.concat(row), [])
  } catch {
    slides = []
  }
  if (slides.length > 0) return slides

  for (const top of figma.currentPage.children) {
    if (top.type !== 'SLIDE_GRID') continue
    for (const row of top.children) {
      if (row.type !== 'SLIDE_ROW') continue
      for (const node of row.children) {
        if (node.type === 'SLIDE') slides.push(node)
      }
    }
  }
  return slides
}

function hasVideoFill(node: SceneNode): node is SceneNode & GeometryMixin {
  if (!('fills' in node)) return false
  const fills = (node as GeometryMixin).fills
  return Array.isArray(fills) && fills.some((f) => f.type === 'VIDEO')
}

function videoPaintOf(node: GeometryMixin): VideoPaint | null {
  const fills = node.fills
  if (!Array.isArray(fills)) return null
  return (fills.find((f) => f.type === 'VIDEO') as VideoPaint | undefined) ?? null
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const r = Math.min(a.x + a.w, b.x + b.w)
  const btm = Math.min(a.y + a.h, b.y + b.h)
  if (r <= x || btm <= y) return null
  return { x, y, w: r - x, h: btm - y }
}

function uniformCornerRadius(node: SceneNode): number {
  if (!('cornerRadius' in node)) return 0
  const r = (node as CornerMixin).cornerRadius
  return typeof r === 'number' && r > 0 ? r : 0
}

/**
 * Describes one video layer relative to its slide: unrotated rectangle (centre-preserving),
 * rotation, how the video is fitted/cropped, shape, and the clip from ancestor frames.
 */
function describeVideo(node: SceneNode & GeometryMixin, slide: SlideNode, paint: VideoPaint): VideoInfo | null {
  const st = slide.absoluteTransform
  const nt = node.absoluteTransform
  const slideX = st[0][2]
  const slideY = st[1][2]

  // absoluteTransform includes any ancestor scaling; derive the rendered size from it.
  const scaleX = Math.hypot(nt[0][0], nt[1][0]) || 1
  const scaleY = Math.hypot(nt[0][1], nt[1][1]) || 1
  const w = node.width * scaleX
  const h = node.height * scaleY
  // Centre of the (possibly rotated) layer, then the unrotated rect around that centre.
  const cx = nt[0][0] * node.width * 0.5 + nt[0][1] * node.height * 0.5 + nt[0][2] - slideX
  const cy = nt[1][0] * node.width * 0.5 + nt[1][1] * node.height * 0.5 + nt[1][2] - slideY
  const rotation = node.id === slide.id || !('rotation' in node) ? 0 : Math.round((node as LayoutMixin).rotation * 100) / 100
  const rect: Rect = { x: cx - w / 2, y: cy - h / 2, w, h }

  // Clip: the slide itself, plus every ancestor frame that clips its content.
  let clip: Rect | null = { x: 0, y: 0, w: SLIDE_W, h: SLIDE_H }
  if (rotation !== 0) {
    clip = null
  } else {
    let p: BaseNode | null = node.parent
    while (p && p.id !== slide.id && clip) {
      if ('clipsContent' in p && (p as FrameNode).clipsContent) {
        const box = (p as FrameNode).absoluteBoundingBox
        if (box) clip = intersect(clip, { x: box.x - slideX, y: box.y - slideY, w: box.width, h: box.height })
      }
      p = p.parent
    }
    if (clip && !intersect(clip, rect)) return null // fully hidden
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
    videoTransform: paint.scaleMode === 'CROP' && paint.videoTransform ? paint.videoTransform.map((row) => Array.from(row)) : null,
    paintRotation: paint.rotation ?? 0,
    shape: node.type === 'ELLIPSE' ? 'ellipse' : 'rect',
    cornerRadius: node.type === 'ELLIPSE' ? 0 : Math.round(uniformCornerRadius(node) * scaleX),
    clip,
  }
}

/** Finds every visible node inside a slide that carries a VIDEO fill. */
function findVideos(slide: SlideNode): VideoInfo[] {
  const out: VideoInfo[] = []

  // The slide itself can have a video fill (video used as slide background).
  if (hasVideoFill(slide)) {
    const paint = videoPaintOf(slide)
    if (paint) {
      const info = describeVideo(slide, slide, paint)
      if (info) out.push(info)
    }
  }

  for (const node of slide.findAll((n) => hasVideoFill(n))) {
    if (!node.visible) continue
    const paint = videoPaintOf(node as unknown as GeometryMixin)
    if (!paint) continue
    const info = describeVideo(node as SceneNode & GeometryMixin, slide, paint)
    if (info) out.push(info)
  }
  return out
}

/** `speakerNotes` exists at runtime but is missing from the published typings. */
function speakerNotesOf(slide: SlideNode): string {
  const notes = (slide as SlideNode & { speakerNotes?: unknown }).speakerNotes
  return typeof notes === 'string' ? notes : ''
}

function describeSlides(slides: SlideNode[]): SlideInfo[] {
  return slides.map((s, index) => ({
    id: s.id,
    index,
    name: s.name,
    isSkipped: s.isSkippedSlide,
    hasNotes: speakerNotesOf(s).trim().length > 0,
    videos: findVideos(s),
  }))
}

function selectedSlideIds(): string[] {
  const ids = figma.currentPage.selection.filter((n) => n.type === 'SLIDE').map((n) => n.id)
  if (ids.length > 0) return ids
  const focused = figma.currentPage.focusedSlide
  return focused ? [focused.id] : []
}

// ---------------------------------------------------------------------------
// Speaker notes: Figma stores a markdown subset (lists, bold, italic, strike).
// PowerPoint notes are plain text, so flatten it.
// ---------------------------------------------------------------------------

export function notesToPlainText(md: string): string {
  return md
    .replace(/\r\n?/g, '\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|[^\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w_])_(?!\s)(.+?)(?<!\s)_(?!\w)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/^(\s*)[-*+]\s+/gm, '$1• ')
    .trim()
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

async function runExport(options: ExportOptions): Promise<void> {
  if (exporting) return
  exporting = true
  try {
    const byId = new Map(collectSlides().map((s) => [s.id, s] as const))
    const ordered: SlideNode[] = []
    for (const id of options.slideIds) {
      const s = byId.get(id)
      if (s) ordered.push(s)
    }
    if (ordered.length === 0) {
      post({ type: 'export-error', message: 'No slides to export.' })
      return
    }

    for (let i = 0; i < ordered.length; i++) {
      const slide = ordered[i]
      // Always lossless PNG here; the UI encodes the JPEG so the quality is ours to control.
      const bytes = await slide.exportAsync({
        format: 'PNG',
        constraint: { type: 'HEIGHT', value: options.height },
        contentsOnly: true,
        useAbsoluteBounds: false,
      })
      post({
        type: 'slide-image',
        slideId: slide.id,
        index: i,
        name: slide.name,
        bytes,
        notes: options.includeNotes ? notesToPlainText(speakerNotesOf(slide)) : '',
        videos: findVideos(slide),
      })
    }
    post({ type: 'export-done', count: ordered.length })
  } catch (err) {
    post({ type: 'export-error', message: err instanceof Error ? err.message : String(err) })
  } finally {
    exporting = false
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function sendInit(): Promise<void> {
  const slides = collectSlides()
  const info = describeSlides(slides)

  // Thumbnails only for slides that contain video, so the "repair video"
  // list can show what each file belongs to. Cheap: 320px wide JPEG.
  const thumbnails: Record<string, Uint8Array> = {}
  for (const s of info) {
    if (s.videos.length === 0) continue
    const node = slides[s.index]
    try {
      thumbnails[s.id] = await node.exportAsync({ format: 'JPG', constraint: { type: 'WIDTH', value: 320 } })
    } catch {
      // thumbnail is optional
    }
  }

  post({ type: 'init', deckName: figma.root.name, slides: info, selectedIds: selectedSlideIds(), thumbnails })
}

if (figma.editorType !== 'slides') {
  figma.closePlugin('Open this plugin from a Figma Slides deck.')
} else {
  figma.showUI(__html__, { width: UI_WIDTH, height: UI_HEIGHT, themeColors: true, title: 'PowerPoint Export' })

  figma.on('selectionchange', () => {
    post({ type: 'selection', selectedIds: selectedSlideIds() })
  })

  figma.ui.onmessage = (msg: UiToMain) => {
    switch (msg.type) {
      case 'ready':
        void sendInit()
        break
      case 'export':
        void runExport(msg.options)
        break
      case 'notify':
        figma.notify(msg.message, { error: msg.error === true })
        break
      case 'close':
        figma.closePlugin()
        break
    }
  }
}
