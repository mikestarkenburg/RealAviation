/**
 * Escape XML special characters for SVG generation
 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Coerce a settings value to a number with a fallback.
 * sdpi-components may return strings; this prevents NaN intervals.
 */
export function toNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Escape special regex characters in a string
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Open a URL in the default browser (cross-platform)
 * Uses platform-appropriate command without shell interpolation
 */
export function openUrl(url: string): void {
  // Use dynamic import to avoid bundling issues
  import('child_process').then(({ execFile }) => {
    if (process.platform === 'win32') {
      execFile('cmd', ['/c', 'start', '', url]);
    } else if (process.platform === 'darwin') {
      execFile('open', [url]);
    } else {
      execFile('xdg-open', [url]);
    }
  });
}
