import crypto from 'node:crypto';
import { MemoryType } from '../models/types.js';

/**
 * Normalizes content text for semantic hashing.
 * When type === 'FAILURE', masks volatile runtime noise (timestamps, line numbers,
 * memory addresses, absolute user home paths) to ensure repeated failures collapse.
 */
export function normalizeContent(content: string, type: MemoryType): string {
  if (!content) return '';

  let normalized = content.normalize('NFKC').toLowerCase();

  if (type === 'FAILURE') {
    // 1. Mask ISO and standard timestamps (e.g. 2026-09-22T01:15:00Z or 2026-09-22 01:15:00.123)
    normalized = normalized.replace(/\d{4}-\d{2}-\d{2}[t\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?/gi, '<timestamp>');

    // 2. Mask memory addresses / hex pointers (e.g. 0x7ffee1b, 0x00007f9c)
    normalized = normalized.replace(/\b0x[0-9a-f]{4,16}\b/gi, '<hex>');

    // 3. Mask UUIDs / GUIDs
    normalized = normalized.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '<uuid>'
    );

    // 4. Mask absolute user home directories (/home/alice/... or /Users/bob/...)
    normalized = normalized.replace(/(?:\/home\/[^/\s]+|\/users\/[^/\s]+)/gi, '~');

    // 5. Mask stack trace line and column numbers (:42:15 -> :<line>:<col>, line 42 -> line <line>)
    normalized = normalized.replace(/:(\d+):(\d+)\b/g, ':<line>:<col>');
    normalized = normalized.replace(/\bline (\d+)\b/gi, 'line <line>');
  }

  // General whitespace normalization
  return normalized
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * Computes a SHA-256 hex digest (64 chars) of normalized memory content.
 */
export function computeSemanticHash(content: string, type: MemoryType): string {
  const normalized = normalizeContent(content, type);
  return crypto.createHash('sha256').update(normalized).digest('hex');
}
