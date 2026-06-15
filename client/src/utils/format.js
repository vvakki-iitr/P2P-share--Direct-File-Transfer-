/**
 * format.js — Human-readable formatting utilities for SecureDrop
 *
 * Centralised display formatters used across the sender and receiver UIs.
 * Kept in one place so we don't duplicate logic in multiple components.
 */

/**
 * Converts a raw byte count into a concise, human-friendly string.
 * Uses binary units (KiB boundaries) but displays with common labels
 * so users see familiar "KB" / "MB" designations.
 *
 * @param {number} bytes - Raw byte count
 * @returns {string} e.g. "4.2 MB"
 */
export function humanFileSize(bytes) {
  if (bytes === 0) return "0 B";
  const KB = 1024;
  const MB = KB * 1024;
  if (bytes < KB) return bytes + " B";
  if (bytes < MB) return (bytes / KB).toFixed(1) + " KB";
  return (bytes / MB).toFixed(2) + " MB";
}

/**
 * Converts a bytes-per-second throughput value into a readable speed string.
 *
 * @param {number} bytesPerSec - Transfer speed in bytes/second
 * @returns {string} e.g. "2.40 MB/s"
 */
export function humanTransferSpeed(bytesPerSec) {
  const KB = 1024;
  const MB = KB * 1024;
  if (bytesPerSec < KB) return bytesPerSec.toFixed(0) + " B/s";
  if (bytesPerSec < MB) return (bytesPerSec / KB).toFixed(1) + " KB/s";
  return (bytesPerSec / MB).toFixed(2) + " MB/s";
}

/**
 * Formats an ISO date string into a short, locale-aware representation.
 *
 * @param {string} iso - ISO 8601 date string
 * @returns {string} e.g. "Jun 15, 2026 10:30 AM"
 */
export function friendlyDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
