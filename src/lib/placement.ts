// Pure geometry: turns a Figma video layer description plus the real video size into
// a PowerPoint shape (rectangle, crop rectangle, rotation, geometry). No DOM, no Figma.

import type { Rect, VideoInfo } from './messages'

export interface VideoDims {
  w: number
  h: number
}

/** Crop as fractions of the full video frame removed from each edge (PowerPoint srcRect). */
export interface SrcRect {
  l: number
  t: number
  r: number
  b: number
}

export interface Placement {
  /** Shape rectangle in slide pixels (unrotated; rotation is about its centre). */
  rect: Rect
  src: SrcRect
  /** Clockwise degrees, PowerPoint convention. */
  rotationDeg: number
  geometry: 'rect' | 'roundRect' | 'ellipse'
  /** For roundRect: PowerPoint adj value (0..50000), radius as a fraction of the shorter side × 100000. */
  roundRectAdj: number
  warnings: string[]
}

const NO_CROP: SrcRect = { l: 0, t: 0, r: 0, b: 0 }

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const r = Math.min(a.x + a.w, b.x + b.w)
  const btm = Math.min(a.y + a.h, b.y + b.h)
  if (r <= x || btm <= y) return null
  return { x, y, w: r - x, h: btm - y }
}

function nearly(a: number, b: number, eps = 0.5): boolean {
  return Math.abs(a - b) <= eps
}

function sameRect(a: Rect, b: Rect): boolean {
  return nearly(a.x, b.x) && nearly(a.y, b.y) && nearly(a.w, b.w) && nearly(a.h, b.h)
}

/**
 * Returns where and how the video shape goes on the PowerPoint slide, or null when
 * nothing of it is visible.
 */
export function computePlacement(v: VideoInfo, dims: VideoDims | null): Placement | null {
  const warnings: string[] = []
  const node: Rect = { x: v.x, y: v.y, w: v.w, h: v.h }
  let rect: Rect = { ...node }
  let src: SrcRect = { ...NO_CROP }

  if (v.paintRotation % 360 !== 0) warnings.push('video rotation inside the layer is not baked')

  if (!dims) {
    if (v.scaleMode !== 'CROP') warnings.push('video size unknown, so the fill crop is not baked')
  }

  switch (v.scaleMode) {
    case 'CROP': {
      const t = v.videoTransform
      const axisAligned = t && t.length === 2 && nearly(t[0][1], 0, 1e-6) && nearly(t[1][0], 0, 1e-6)
      if (t && axisAligned) {
        const sx = t[0][0]
        const sy = t[1][1]
        const tx = t[0][2]
        const ty = t[1][2]
        src = { l: tx, t: ty, r: 1 - (tx + sx), b: 1 - (ty + sy) }
      } else {
        warnings.push('rotated crop is not supported, exported as fill')
        src = fillCrop(node, dims)
      }
      break
    }
    case 'FIT': {
      if (dims) {
        const s = Math.min(node.w / dims.w, node.h / dims.h)
        const dw = dims.w * s
        const dh = dims.h * s
        rect = { x: node.x + (node.w - dw) / 2, y: node.y + (node.h - dh) / 2, w: dw, h: dh }
      }
      break
    }
    case 'TILE':
      warnings.push('tiled video is not supported, exported as fill')
      src = fillCrop(node, dims)
      break
    case 'FILL':
    default:
      src = fillCrop(node, dims)
      break
  }

  // Clip by the slide and clipping ancestor frames: shrink the shape, and crop further so
  // the video content stays put.
  if (v.clip) {
    const visible = intersect(rect, v.clip)
    if (!visible) return null
    if (!sameRect(visible, rect)) {
      const spanW = 1 - src.l - src.r
      const spanH = 1 - src.t - src.b
      const fx0 = (visible.x - rect.x) / rect.w
      const fx1 = (visible.x + visible.w - rect.x) / rect.w
      const fy0 = (visible.y - rect.y) / rect.h
      const fy1 = (visible.y + visible.h - rect.y) / rect.h
      src = {
        l: src.l + fx0 * spanW,
        r: 1 - (src.l + fx1 * spanW),
        t: src.t + fy0 * spanH,
        b: 1 - (src.t + fy1 * spanH),
      }
      rect = visible
    }
  }

  // Geometry: only when the whole layer is visible, since a clipped corner isn't round any more.
  let geometry: Placement['geometry'] = 'rect'
  let roundRectAdj = 0
  if (sameRect(rect, node)) {
    if (v.shape === 'ellipse') {
      geometry = 'ellipse'
    } else if (v.cornerRadius > 0) {
      geometry = 'roundRect'
      roundRectAdj = Math.min(50000, Math.round((v.cornerRadius / Math.min(rect.w, rect.h)) * 100000))
    }
  } else if (v.shape === 'ellipse' || v.cornerRadius > 0) {
    warnings.push('shape is clipped, so its rounded edges are not baked')
  }

  const clamp = (f: number) => Math.max(0, Math.min(0.999, f))
  src = { l: clamp(src.l), t: clamp(src.t), r: clamp(src.r), b: clamp(src.b) }

  return {
    rect,
    src,
    rotationDeg: v.rotation ? -v.rotation : 0, // Figma counter-clockwise -> PowerPoint clockwise
    geometry,
    roundRectAdj,
    warnings,
  }
}

/** Centre-cover crop: the video is scaled to cover the layer and the overflow is trimmed. */
function fillCrop(node: Rect, dims: VideoDims | null): SrcRect {
  if (!dims) return { ...NO_CROP }
  const s = Math.max(node.w / dims.w, node.h / dims.h)
  const fx = node.w / (dims.w * s)
  const fy = node.h / (dims.h * s)
  return { l: (1 - fx) / 2, r: (1 - fx) / 2, t: (1 - fy) / 2, b: (1 - fy) / 2 }
}
