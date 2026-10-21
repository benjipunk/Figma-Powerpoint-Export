// Shared message contract between the plugin main thread (code.ts) and the UI (ui.ts).

export const SLIDE_W = 1920
export const SLIDE_H = 1080

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type VideoScaleMode = 'FILL' | 'FIT' | 'CROP' | 'TILE'

/**
 * Everything needed to reproduce how a video layer looks in Figma inside PowerPoint.
 * All coordinates are slide pixels (1920x1080 space).
 */
export interface VideoInfo {
  nodeId: string
  name: string
  videoHash: string | null
  /** The layer's own (unrotated) rectangle, positioned so its centre matches the layer's centre. */
  x: number
  y: number
  w: number
  h: number
  /** Layer rotation in degrees, Figma convention (counter-clockwise positive). */
  rotation: number
  scaleMode: VideoScaleMode
  /** Figma's crop transform for scaleMode CROP: [[sx, 0, tx], [0, sy, ty]] in normalized video space. */
  videoTransform: number[][] | null
  /** Rotation of the video inside the layer (multiples of 90). Not baked; reported as a warning. */
  paintRotation: number
  shape: 'rect' | 'ellipse'
  /** Uniform corner radius in slide px; 0 when none or per-corner radii differ. */
  cornerRadius: number
  /**
   * Visible area after clipping by the slide and any ancestor frames that clip content.
   * null when the layer is rotated (clipping a rotated layer is not baked).
   */
  clip: Rect | null
}

export interface SlideInfo {
  id: string
  /** 0-based position in presentation order. */
  index: number
  name: string
  isSkipped: boolean
  hasNotes: boolean
  videos: VideoInfo[]
}

export interface ExportOptions {
  slideIds: string[]
  /** Output image height in pixels (1080, 1440 or 2160). Width follows 16:9. */
  height: number
  includeNotes: boolean
}

export type MainToUi =
  | {
      type: 'init'
      deckName: string
      slides: SlideInfo[]
      selectedIds: string[]
      /** Small JPEG thumbnails for slides that contain video, keyed by slide id. */
      thumbnails: Record<string, Uint8Array>
    }
  | { type: 'selection'; selectedIds: string[] }
  | {
      type: 'slide-image'
      slideId: string
      index: number
      name: string
      /** Lossless PNG from Figma; the UI encodes the final JPEG. */
      bytes: Uint8Array
      notes: string
      videos: VideoInfo[]
    }
  | { type: 'export-done'; count: number }
  | { type: 'export-error'; message: string }

export type UiToMain =
  | { type: 'ready' }
  | { type: 'export'; options: ExportOptions }
  | { type: 'notify'; message: string; error?: boolean }
  | { type: 'close' }
