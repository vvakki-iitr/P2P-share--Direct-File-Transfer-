/**
 * crypto.js — Client-side encryption layer for P2PShare
 *
 * The core privacy guarantee of our project: the signaling server never
 * touches the encryption key. We generate a 256-bit AES-GCM key entirely
 * in the sender's browser, then pass it to the receiver through the URL
 * fragment (#key=...). Because the fragment is never sent to the server
 * in an HTTP request, the server is cryptographically blind to file
 * contents — achieving a zero-knowledge relay design.
 *
 * Each file chunk is encrypted individually with a fresh random IV so we
 * can stream large files through the WebRTC data channel without having
 * to buffer the entire file in memory first.
 */

const ALGO = "AES-GCM";
const KEY_BITS = 256;
const IV_BYTES = 12; // 96-bit IV — recommended size for GCM to avoid birthday collisions

/**
 * Create a new encryption key and return both the CryptoKey handle and a
 * base64url-encoded version we can safely embed in a shareable link.
 * We mark it extractable because we need to serialize it for the URL.
 */
export async function generateKey() {
  const key = await crypto.subtle.generateKey(
    { name: ALGO, length: KEY_BITS },
    true,
    ["encrypt", "decrypt"]
  );
  const raw = await crypto.subtle.exportKey("raw", key);
  return { key, keyB64: arrayBufferToBase64url(raw) };
}

/**
 * Reconstruct a CryptoKey from the base64url string the receiver pulls
 * out of the URL fragment. Non-extractable this time — the receiver
 * doesn't need to re-export it.
 */
export async function importKey(keyB64) {
  const raw = base64urlToArrayBuffer(keyB64);
  return crypto.subtle.importKey("raw", raw, { name: ALGO }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Encrypt one file chunk (ArrayBuffer) and return a combined buffer:
 *   [ 12-byte IV | ciphertext + GCM auth tag ]
 * We prepend the IV so the receiver can split it back out without any
 * out-of-band coordination.
 */
export async function encryptChunk(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGO, iv },
    key,
    plaintext
  );
  const result = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), IV_BYTES);
  return result.buffer;
}

/**
 * Inverse of encryptChunk — strips the leading IV, then decrypts.
 * GCM's built-in auth tag ensures tampered chunks throw automatically.
 */
export async function decryptChunk(key, encryptedChunk) {
  const data = new Uint8Array(encryptedChunk);
  const iv = data.slice(0, IV_BYTES);
  const ciphertext = data.slice(IV_BYTES);
  return crypto.subtle.decrypt({ name: ALGO, iv }, key, ciphertext);
}

// ─── Encoding helpers ─────────────────────────────────────────────────────────
// We use base64url (RFC 4648 §5) instead of plain base64 so the key is
// safe to embed directly in a URL without percent-encoding issues.

function arrayBufferToBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64urlToArrayBuffer(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Hash a file buffer with SHA-256 and return the hex digest.
 * We use this for post-transfer integrity checks — the sender hashes
 * the original file, the receiver hashes the reassembled file, and
 * we compare to make sure nothing got corrupted or tampered with.
 */
export async function sha256Hex(buffer) {
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
