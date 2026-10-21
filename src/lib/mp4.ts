// Reads the display size of an MP4/M4V/MOV from its container (moov > trak > tkhd),
// without decoding any video. Returns null for anything that isn't ISO BMFF.

import type { VideoDims } from './placement'

type Visitor = (type: string, start: number, end: number) => void

export function mp4Dimensions(buffer: ArrayBuffer): VideoDims | null {
  const dv = new DataView(buffer)
  const type4 = (p: number) => String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3))

  function walk(start: number, end: number, visit: Visitor): void {
    let p = start
    while (p + 8 <= end) {
      let size = dv.getUint32(p)
      const type = type4(p + 4)
      let header = 8
      if (size === 1) {
        if (p + 16 > end) return
        size = Number(dv.getBigUint64(p + 8))
        header = 16
      } else if (size === 0) {
        size = end - p
      }
      if (size < header || p + size > end) return
      visit(type, p + header, p + size)
      p += size
    }
  }

  if (buffer.byteLength < 16 || type4(4) !== 'ftyp') {
    // QuickTime files may start with other boxes; still try if a moov shows up.
    if (buffer.byteLength < 16) return null
  }

  let result: VideoDims | null = null
  walk(0, buffer.byteLength, (type, s, e) => {
    if (type !== 'moov' || result) return
    walk(s, e, (t2, s2, e2) => {
      if (t2 !== 'trak' || result) return
      // Assigned inside callbacks, so keep them on an object: TS can't narrow closure writes.
      const found: { isVideo: boolean; dims: VideoDims | null } = { isVideo: false, dims: null }
      walk(s2, e2, (t3, s3, e3) => {
        if (t3 === 'tkhd') {
          const version = dv.getUint8(s3)
          // version/flags (4) + times/ids (20 or 32) + reserved/layer/group/volume/reserved (16)
          const matrixAt = s3 + 4 + (version === 1 ? 32 : 20) + 16
          if (matrixAt + 44 > e3) return
          const a = dv.getInt32(matrixAt) / 65536
          const b = dv.getInt32(matrixAt + 4) / 65536
          const c = dv.getInt32(matrixAt + 12) / 65536
          const d = dv.getInt32(matrixAt + 16) / 65536
          const w = dv.getUint32(matrixAt + 36) / 65536
          const h = dv.getUint32(matrixAt + 40) / 65536
          // A 90/270 degree track matrix (phone footage) swaps the displayed axes.
          const quarterTurn = Math.abs(a) < 0.01 && Math.abs(d) < 0.01 && Math.abs(b) > 0.5 && Math.abs(c) > 0.5
          found.dims = quarterTurn ? { w: Math.round(h), h: Math.round(w) } : { w: Math.round(w), h: Math.round(h) }
        } else if (t3 === 'mdia') {
          walk(s3, e3, (t4, s4) => {
            if (t4 === 'hdlr' && type4(s4 + 8) === 'vide') found.isVideo = true
          })
        }
      })
      if (found.isVideo && found.dims && found.dims.w > 0 && found.dims.h > 0) result = found.dims
    })
  })
  return result
}
