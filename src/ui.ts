// Plugin UI (iframe). Has a full browser environment but no Figma access.
// Responsibilities: options, video file intake, JPEG encoding, PPTX assembly
// with PptxGenJS, and the download.

import PptxGenJS from 'pptxgenjs'
import JSZip from 'jszip'
import type { ExportOptions, MainToUi, Rect, SlideInfo, UiToMain, VideoInfo } from './lib/messages'
import { SLIDE_H, SLIDE_W } from './lib/messages'
import { computePlacement, type Placement, type VideoDims } from './lib/placement'
import { mp4Dimensions } from './lib/mp4'

// PptxGenJS 16:9 layout is 10in x 5.625in.
const LAYOUT_W_IN = 10
const LAYOUT_H_IN = 5.625

/** Fixed JPEG quality: "web" grade. Roughly 150-300 KB per 1440p slide. */
const JPEG_QUALITY = 0.75

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface VideoFile {
  file: File
  base64: string
  mime: string
  extn: string
  /** Pixel size of the video, or null when it could not be determined (crop then can't be baked). */
  dims: VideoDims | null
}

interface RenderedSlide {
  slideId: string
  index: number
  name: string
  /** Data URL of the final JPEG. */
  dataUrl: string
  /** Same image as a Blob, kept for cropping video covers. */
  blob: Blob
  bytes: number
  notes: string
  videos: VideoInfo[]
}

let deckName = 'Presentation'
let slides: SlideInfo[] = []
let selectedIds: string[] = []
let thumbnails: Record<string, string> = {}
let exporting = false
let rendered: RenderedSlide[] = []
let expected = 0
let pendingEncodes = 0
let doneSignalled = false

/** Chosen files, keyed by `${slideId}:${nodeId}`. */
const videoFiles = new Map<string, VideoFile>()

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Missing element #${id}`)
  return el as T
}

const els = {
  deckName: $<HTMLHeadingElement>('deckName'),
  deckMeta: $<HTMLDivElement>('deckMeta'),
  scopeSelected: $<HTMLInputElement>('scopeSelected'),
  selCount: $<HTMLSpanElement>('selCount'),
  includeSkipped: $<HTMLInputElement>('includeSkipped'),
  includeNotes: $<HTMLInputElement>('includeNotes'),
  height: $<HTMLSelectElement>('height'),
  videoSection: $<HTMLElement>('videoSection'),
  videoCount: $<HTMLSpanElement>('videoCount'),
  videoList: $<HTMLDivElement>('videoList'),
  status: $<HTMLDivElement>('status'),
  bar: $<HTMLDivElement>('bar'),
  exportBtn: $<HTMLButtonElement>('exportBtn'),
}

function send(msg: UiToMain): void {
  parent.postMessage({ pluginMessage: msg }, '*')
}

function setStatus(text: string, error = false): void {
  els.status.textContent = text
  els.status.classList.toggle('error', error)
}

function setProgress(fraction: number): void {
  els.bar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`
}

function formatMB(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`
}

function scopeIsSelected(): boolean {
  return els.scopeSelected.checked
}

function slidesInScope(): SlideInfo[] {
  const includeSkipped = els.includeSkipped.checked
  let list = slides
  if (scopeIsSelected()) {
    const set = new Set(selectedIds)
    list = slides.filter((s) => set.has(s.id))
  }
  return list.filter((s) => includeSkipped || !s.isSkipped)
}

function videosInScope(): Array<{ slide: SlideInfo; video: VideoInfo }> {
  const out: Array<{ slide: SlideInfo; video: VideoInfo }> = []
  for (const slide of slidesInScope()) for (const video of slide.videos) out.push({ slide, video })
  return out
}

function refreshSummary(): void {
  const inScope = slidesInScope()
  const videos = videosInScope()
  const missing = videos.filter((v) => !videoFiles.has(`${v.slide.id}:${v.video.nodeId}`)).length

  els.selCount.textContent = String(selectedIds.length)
  els.scopeSelected.disabled = selectedIds.length === 0
  if (selectedIds.length === 0 && scopeIsSelected()) {
    const all = document.querySelector<HTMLInputElement>('input[name=scope][value=all]')
    if (all) all.checked = true
  }

  els.videoSection.hidden = videos.length === 0
  els.videoCount.textContent = missing > 0 ? `${missing} of ${videos.length} need a file` : `${videos.length} ready`
  els.videoCount.className = `pill ${missing > 0 ? 'warn' : 'ok'}`

  els.exportBtn.disabled = exporting || inScope.length === 0
  els.exportBtn.textContent = exporting
    ? 'Exporting…'
    : `Export ${inScope.length} slide${inScope.length === 1 ? '' : 's'} to PowerPoint`

  if (!exporting) {
    const note = missing > 0 ? `${missing} video slide${missing === 1 ? '' : 's'} will export as a still image` : ''
    setStatus(note)
  }
}

// ---------------------------------------------------------------------------
// Video list
// ---------------------------------------------------------------------------

/** Cards are kept per video so re-rendering on a settings change never resets a chosen file. */
const videoCards = new Map<string, HTMLElement>()

function renderVideoList(): void {
  const wanted = videosInScope()
  const keep = new Set<string>()
  for (const { slide, video } of wanted) {
    const key = `${slide.id}:${video.nodeId}`
    keep.add(key)
    let card = videoCards.get(key)
    if (!card) {
      card = buildVideoCard(key, slide, video)
      videoCards.set(key, card)
    }
    els.videoList.appendChild(card) // appending an existing node just moves it into order
  }
  for (const [key, card] of videoCards) {
    if (!keep.has(key)) {
      card.remove()
      videoCards.delete(key) // the chosen file stays in videoFiles in case the slide comes back
    }
  }
}

function buildVideoCard(key: string, slide: SlideInfo, video: VideoInfo): HTMLElement {
  const card = document.createElement('div')
  card.className = 'video'

  const thumb = thumbnails[slide.id]
  if (thumb) {
    const img = document.createElement('img')
    img.src = thumb
    card.appendChild(img)
  } else {
    const ph = document.createElement('div')
    ph.className = 'thumb'
    card.appendChild(ph)
  }

  const body = document.createElement('div')
  const title = document.createElement('div')
  title.className = 'title'
  title.textContent = `Slide ${slide.index + 1}: ${slide.name}`
  body.appendChild(title)

  const meta = document.createElement('div')
  meta.className = 'muted'
  const isFull = video.x === 0 && video.y === 0 && video.w === SLIDE_W && video.h === SLIDE_H
  const mode = video.scaleMode === 'CROP' ? 'cropped' : video.scaleMode === 'FIT' ? 'fit' : 'fill'
  meta.textContent = `${video.name} · ${Math.round(video.w)}×${Math.round(video.h)} · ${isFull ? 'fullscreen' : mode}${video.rotation ? ` · ${video.rotation}°` : ''}`
  body.appendChild(meta)

  const fileRow = document.createElement('div')
  fileRow.className = 'file'
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'video/mp4,video/quicktime,video/webm,.mp4,.m4v,.mov,.webm'
  const chosen = document.createElement('div')
  chosen.className = 'hint'
  const replace = document.createElement('button')
  replace.type = 'button'
  replace.className = 'small'
  replace.textContent = 'Replace'
  replace.addEventListener('click', () => input.click())

  const showState = () => {
    const vf = videoFiles.get(key)
    input.hidden = !!vf
    replace.hidden = !vf
    if (vf) {
      const dims = vf.dims ? `${vf.dims.w}×${vf.dims.h}` : 'size unknown, crop not baked'
      const warnings = computePlacement(video, vf.dims)?.warnings ?? []
      chosen.textContent = `${vf.file.name} (${formatMB(vf.file.size)}, ${dims})${warnings.length ? ' · ' + warnings.join(' · ') : ''}`
    } else {
      chosen.textContent = 'No file chosen'
    }
  }

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0]
    if (!file) return
    chosen.textContent = `Reading ${file.name}…`
    try {
      videoFiles.set(key, await readVideoFile(file))
      showState()
    } catch (err) {
      videoFiles.delete(key)
      showState()
      chosen.textContent = `Could not read file: ${err instanceof Error ? err.message : String(err)}`
    }
    input.value = ''
    refreshSummary()
  })

  fileRow.appendChild(input)
  fileRow.appendChild(replace)
  fileRow.appendChild(chosen)
  body.appendChild(fileRow)
  card.appendChild(body)
  showState()
  return card
}

async function readVideoFile(file: File): Promise<VideoFile> {
  if (file.size > 100 * 1024 * 1024) {
    throw new Error('Video is over 100 MB. Compress it first so the PowerPoint stays usable.')
  }
  const name = file.name.toLowerCase()
  let mime = file.type
  let extn = name.includes('.') ? name.split('.').pop() || 'mp4' : 'mp4'
  if (extn === 'm4v') extn = 'mp4'
  if (!mime) mime = extn === 'mov' ? 'video/quicktime' : extn === 'webm' ? 'video/webm' : 'video/mp4'
  if (mime === 'video/quicktime') extn = 'mov'
  if (mime === 'video/webm') extn = 'webm'
  if (mime === 'video/mp4') extn = 'mp4'
  const buffer = await file.arrayBuffer()
  const base64 = bytesToBase64(new Uint8Array(buffer))
  // MP4/MOV: read the size from the container directly (works without media playback).
  // Anything else: ask a <video> element, and give up quietly if it can't decode.
  const dims = mp4Dimensions(buffer) ?? (await probeVideoDims(file))
  return { file, base64, mime, extn, dims }
}

function probeVideoDims(file: File): Promise<VideoDims | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    const done = (d: VideoDims | null) => {
      clearTimeout(timer)
      URL.revokeObjectURL(url)
      resolve(d)
    }
    const timer = setTimeout(() => done(null), 4000)
    video.preload = 'metadata'
    video.muted = true
    video.onloadedmetadata = () => done(video.videoWidth > 0 ? { w: video.videoWidth, h: video.videoHeight } : null)
    video.onerror = () => done(null)
    video.src = url
  })
}

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
  }
  return btoa(binary)
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image encoding failed'))), type, quality)
  })
}

async function decodeToCanvas(blob: Blob, crop?: { sx: number; sy: number; sw: number; sh: number }): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  const sx = crop ? crop.sx : 0
  const sy = crop ? crop.sy : 0
  const sw = crop ? crop.sw : bmp.width
  const sh = crop ? crop.sh : bmp.height
  canvas.width = Math.max(1, Math.round(sw))
  canvas.height = Math.max(1, Math.round(sh))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  // JPEG has no alpha; flatten onto white so transparent slide areas don't go black.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  bmp.close()
  return canvas
}

/** Encodes Figma's lossless PNG into the final JPEG. */
async function encodeSlide(pngBytes: Uint8Array): Promise<{ dataUrl: string; blob: Blob; bytes: number }> {
  // Copy into a fresh ArrayBuffer-backed array; structured-cloned data may not satisfy BlobPart typing.
  const png = new Blob([new Uint8Array(pngBytes)], { type: 'image/png' })
  const canvas = await decodeToCanvas(png)
  const out = await canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY)
  return { dataUrl: await blobToDataUrl(out), blob: out, bytes: out.size }
}

/**
 * A PNG poster frame for a video. PowerPoint applies the shape's crop rectangle to the poster
 * as well as to the video, so the poster must be laid out like a full video frame: the slide
 * pixels that sit under the shape are painted into the crop region, the rest stays black.
 */
async function makeCover(slideBlob: Blob, placement: Placement, dims: VideoDims | null): Promise<string> {
  const slideBmp = await createImageBitmap(slideBlob)
  const scale = slideBmp.width / SLIDE_W
  const shape = placement.rect
  const visibleW = 1 - placement.src.l - placement.src.r
  const visibleH = 1 - placement.src.t - placement.src.b

  // Poster size: the video's aspect ratio, capped at 1920 wide. Without dims the poster is just the shape.
  const aspect = dims ? dims.w / dims.h : shape.w / shape.h
  const pw = Math.min(1920, Math.max(2, Math.round(dims ? dims.w : shape.w * scale)))
  const ph = Math.max(2, Math.round(pw / aspect))

  const canvas = document.createElement('canvas')
  canvas.width = pw
  canvas.height = ph
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, pw, ph)
  ctx.drawImage(
    slideBmp,
    shape.x * scale,
    shape.y * scale,
    shape.w * scale,
    shape.h * scale,
    placement.src.l * pw,
    placement.src.t * ph,
    visibleW * pw,
    visibleH * ph,
  )
  slideBmp.close()
  return blobToDataUrl(await canvasToBlob(canvas, 'image/png'))
}

/**
 * PptxGenJS can't express crop, rotation or shape geometry on media, so those are written
 * straight into the slide XML after the file is generated.
 */
async function patchVideoShapes(pptxBuffer: ArrayBuffer, perSlide: Map<number, Placement[]>): Promise<Blob> {
  const zip = await JSZip.loadAsync(pptxBuffer)
  for (const [slideNo, placements] of perSlide) {
    const path = `ppt/slides/slide${slideNo}.xml`
    const entry = zip.file(path)
    if (!entry) continue
    let xml = await entry.async('string')
    let k = 0
    xml = xml.replace(/<p:pic>[\s\S]*?<\/p:pic>/g, (block) => {
      if (!block.includes('<a:videoFile')) return block
      const p = placements[k++]
      if (!p) return block
      const pct = (f: number) => Math.round(Math.max(0, Math.min(0.999, f)) * 100000)
      const { l, t, r, b } = p.src
      if (l + t + r + b > 0) {
        block = block.replace(/(<a:blip r:embed="[^"]*"\s*\/>)/, `$1<a:srcRect l="${pct(l)}" t="${pct(t)}" r="${pct(r)}" b="${pct(b)}"/>`)
      }
      if (p.rotationDeg !== 0) {
        const rot = Math.round((((p.rotationDeg % 360) + 360) % 360) * 60000)
        block = block.replace('<a:xfrm>', `<a:xfrm rot="${rot}">`)
      }
      if (p.geometry === 'ellipse') {
        block = block.replace('<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>', '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>')
      } else if (p.geometry === 'roundRect') {
        block = block.replace(
          '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>',
          `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${p.roundRectAdj}"/></a:avLst></a:prstGeom>`,
        )
      }
      return block
    })
    zip.file(path, xml)
  }
  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    compression: 'DEFLATE',
  })
}

/** PptxGenJS wants "image/png;base64,..." (no "data:" prefix). */
function stripDataPrefix(dataUrl: string): string {
  return dataUrl.startsWith('data:') ? dataUrl.slice(5) : dataUrl
}

// ---------------------------------------------------------------------------
// PPTX assembly
// ---------------------------------------------------------------------------

async function buildPptx(): Promise<Blob> {
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_16x9'
  pptx.title = deckName
  pptx.author = 'Figma PowerPoint Export'

  const ordered = rendered.slice().sort((a, b) => a.index - b.index)
  const patches = new Map<number, Placement[]>()

  for (let i = 0; i < ordered.length; i++) {
    const r = ordered[i]
    const slide = pptx.addSlide()

    // IMPORTANT: a full-bleed picture shape, never `slide.background`.
    // A per-slide picture *background* is collapsed into one image by macOS
    // Quick Look (every slide previews as slide 1). A picture shape is fine.
    slide.addImage({ data: stripDataPrefix(r.dataUrl), x: 0, y: 0, w: '100%', h: '100%' })

    // Videos go on top of the slide image, placed, cropped, rotated and shaped as in Figma.
    const placements: Placement[] = []
    for (const v of r.videos) {
      const vf = videoFiles.get(`${r.slideId}:${v.nodeId}`)
      if (!vf) continue
      const placement = computePlacement(v, vf.dims)
      if (!placement) continue
      const cover = await makeCover(r.blob, placement, vf.dims)
      const rect: Rect = placement.rect
      slide.addMedia({
        type: 'video',
        data: `${vf.mime};base64,${vf.base64}`,
        extn: vf.extn,
        cover: stripDataPrefix(cover),
        x: (rect.x / SLIDE_W) * LAYOUT_W_IN,
        y: (rect.y / SLIDE_H) * LAYOUT_H_IN,
        w: (rect.w / SLIDE_W) * LAYOUT_W_IN,
        h: (rect.h / SLIDE_H) * LAYOUT_H_IN,
      })
      placements.push(placement)
    }
    if (placements.length) patches.set(i + 1, placements)

    if (r.notes) slide.addNotes(r.notes)
  }

  const out = await pptx.write({ outputType: 'arraybuffer' })
  if (!(out instanceof ArrayBuffer)) throw new Error('Unexpected PPTX output')
  if (patches.size === 0) {
    return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })
  }
  return patchVideoShapes(out, patches)
}

function download(blob: Blob, filename: string): void {
  // Test hook: the headless-browser harness in test/ captures the file instead of downloading it.
  const hook = (window as unknown as { __onPptxBlob?: (b: Blob, name: string) => void }).__onPptxBlob
  if (typeof hook === 'function') {
    hook(blob, filename)
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function safeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim()
  return (cleaned || 'Presentation') + '.pptx'
}

// ---------------------------------------------------------------------------
// Export flow
// ---------------------------------------------------------------------------

function currentOptions(): ExportOptions {
  return {
    slideIds: slidesInScope().map((s) => s.id),
    height: Number(els.height.value),
    includeNotes: els.includeNotes.checked,
  }
}

function startExport(): void {
  if (exporting) return
  const options = currentOptions()
  if (options.slideIds.length === 0) return
  exporting = true
  doneSignalled = false
  rendered = []
  expected = options.slideIds.length
  pendingEncodes = 0
  setProgress(0)
  setStatus(`Rendering slide 1 of ${expected}…`)
  refreshSummary()
  send({ type: 'export', options })
}

function finishExport(message: string, error = false): void {
  exporting = false
  setProgress(error ? 0 : 1)
  refreshSummary()
  setStatus(message, error)
}

async function onSlideImage(msg: Extract<MainToUi, { type: 'slide-image' }>): Promise<void> {
  if (!exporting) return
  pendingEncodes++
  try {
    const { dataUrl, blob, bytes } = await encodeSlide(msg.bytes)
    rendered.push({ slideId: msg.slideId, index: msg.index, name: msg.name, dataUrl, blob, bytes, notes: msg.notes, videos: msg.videos })
  } finally {
    pendingEncodes--
  }
  const total = rendered.reduce((n, r) => n + r.bytes, 0)
  setProgress((rendered.length / expected) * 0.9)
  const next = Math.min(msg.index + 2, expected)
  setStatus(`Rendering slide ${next} of ${expected} · ${formatMB(total)} so far`)
  void maybeAssemble()
}

async function maybeAssemble(): Promise<void> {
  if (!doneSignalled || pendingEncodes > 0 || rendered.length < expected) return
  doneSignalled = false
  try {
    setStatus('Building PowerPoint file…')
    const blob = await buildPptx()
    download(blob, safeFilename(deckName))
    finishExport(`Done · ${rendered.length} slides · ${formatMB(blob.size)}`)
    send({ type: 'notify', message: `Exported ${rendered.length} slides (${formatMB(blob.size)})` })
  } catch (err) {
    finishExport(`Failed: ${err instanceof Error ? err.message : String(err)}`, true)
  } finally {
    rendered = []
  }
}

// ---------------------------------------------------------------------------
// Messages from main thread
// ---------------------------------------------------------------------------

window.onmessage = (event: MessageEvent) => {
  const msg = event.data && (event.data.pluginMessage as MainToUi | undefined)
  if (!msg) return
  switch (msg.type) {
    case 'init': {
      deckName = msg.deckName
      slides = msg.slides
      selectedIds = msg.selectedIds
      thumbnails = {}
      for (const id of Object.keys(msg.thumbnails)) {
        thumbnails[id] = `data:image/jpeg;base64,${bytesToBase64(msg.thumbnails[id])}`
      }
      const videoSlides = slides.filter((s) => s.videos.length > 0).length
      const hidden = slides.filter((s) => s.isSkipped).length
      els.deckName.textContent = deckName
      els.deckMeta.textContent =
        `${slides.length} slides` + (videoSlides ? ` · ${videoSlides} with video` : '') + (hidden ? ` · ${hidden} hidden` : '')
      renderVideoList()
      refreshSummary()
      break
    }
    case 'selection':
      selectedIds = msg.selectedIds
      if (!exporting) {
        renderVideoList()
        refreshSummary()
      }
      break
    case 'slide-image':
      void onSlideImage(msg)
      break
    case 'export-done':
      doneSignalled = true
      void maybeAssemble()
      break
    case 'export-error':
      finishExport(`Failed: ${msg.message}`, true)
      break
  }
}

// ---------------------------------------------------------------------------
// Wire up controls
// ---------------------------------------------------------------------------

for (const el of [els.includeSkipped, els.includeNotes, els.height]) {
  el.addEventListener('change', () => {
    renderVideoList()
    refreshSummary()
  })
}
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name=scope]')) {
  radio.addEventListener('change', () => {
    renderVideoList()
    refreshSummary()
  })
}
els.exportBtn.addEventListener('click', startExport)

send({ type: 'ready' })
