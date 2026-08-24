/**
 * ArcFX brand mark — src/shared/brand.ts
 *
 * A flat wordmark to replace the circular avatar. The avatar was a raster
 * photo-style badge: it needed a border to sit on dark chrome, and on the paper
 * ground of an invoice it read as a pasted-in profile picture rather than a
 * letterhead.
 *
 * The mark is two points joined by an arc — a payment travelling from payer to
 * recipient, and literally an arc. It is stroke-based and uses currentColor, so
 * one asset works on paper, on dark chrome, and in a PDF, at any size, with no
 * second file to keep in sync.
 */

/** Just the glyph. Square, 24×24, inherits colour from its parent. */
export function arcfxMark(size = 24): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    role="img" aria-label="ArcFX" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0;">
    <path d="M4 17.5C4 10.6 7.6 6.5 12 6.5s8 4.1 8 11"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>
    <circle cx="4" cy="17.5" r="2.4" fill="currentColor"/>
    <circle cx="20" cy="17.5" r="2.4" fill="currentColor"/>
  </svg>`;
}

/**
 * Mark plus wordmark. The wordmark stays in one typeface across both registers:
 * a brand should not change face depending on which screen it is on, even when
 * the surrounding type does.
 */
export function arcfxLockup(opts: { size?: number; color?: string; showText?: boolean } = {}): string {
  const size = opts.size ?? 26;
  const color = opts.color ?? 'currentColor';
  const showText = opts.showText !== false;
  const text = showText
    ? `<span style="font-family:'Archivo',ui-sans-serif,system-ui,sans-serif;font-size:${Math.round(size * 0.62)}px;font-weight:700;letter-spacing:-0.02em;line-height:1;">ArcFX</span>`
    : '';
  return `<span style="display:inline-flex;align-items:center;gap:8px;color:${color};">${arcfxMark(size)}${text}</span>`;
}

/**
 * Flat mark as a standalone SVG document, for the PDF generator and anywhere
 * that needs a file rather than inline markup. `hex` is a plain colour because
 * currentColor has nothing to inherit from outside a document.
 */
export function arcfxMarkSvg(hex = '#0A0A0A'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">
    <path d="M4 17.5C4 10.6 7.6 6.5 12 6.5s8 4.1 8 11" stroke="${hex}" stroke-width="2" stroke-linecap="round" fill="none"/>
    <circle cx="4" cy="17.5" r="2.4" fill="${hex}"/>
    <circle cx="20" cy="17.5" r="2.4" fill="${hex}"/>
  </svg>`;
}
