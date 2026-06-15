/**
 * useWebRTC.js — WebRTC Peer Connection & Encrypted File Transfer Hook
 *
 * This custom React hook encapsulates the entire WebRTC lifecycle for SecureDrop:
 *   1. Creating an RTCPeerConnection with STUN servers for NAT traversal
 *   2. Managing the DataChannel for binary data transfer
 *   3. Encrypting each file chunk (AES-GCM) before sending, decrypting on receive
 *   4. Implementing backpressure control so the DataChannel buffer doesn't overflow
 *   5. Tracking per-file progress, transfer speed, and SHA-256 integrity verification
 *
 * The hook supports cumulative file indices across multiple batches, allowing
 * the sender to stay connected and send additional files without reconnecting.
 * Each file is streamed in 64 KB chunks, with the receiver reassembling and
 * verifying the full file hash before marking it as complete.
 */
import { useRef, useCallback } from "react";
import { encryptChunk, decryptChunk, sha256Hex } from "../utils/crypto";

// ─── Transfer Configuration ──────────────────────────────────────────────────
// 64 KB chunks balance transfer speed with memory usage in the browser
const CHUNK_SIZE = 64 * 1024;
// Backpressure thresholds prevent the DataChannel buffer from overflowing
const BUFFERED_AMOUNT_LOW_THRESHOLD = 8 * 1024 * 1024;
const BUFFERED_AMOUNT_HIGH = 16 * 1024 * 1024;
// Google's public STUN servers help peers discover their public IP for NAT traversal
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

/**
 * useWebRTC — manages RTCPeerConnection, DataChannel, and multi-file transfer.
 */
export function useWebRTC({
  sendOffer,
  sendAnswer,
  sendIceCandidate,
  onFileProgress,
  onFileComplete,
  onAllComplete,
  onStatusChange,
  onError,
  onIdentity,
}) {
  const pcRef = useRef(null);
  const channelRef = useRef(null);
  const cryptoKeyRef = useRef(null);
  const localNameRef = useRef("");

  const receiveStateRef = useRef({ currentFile: null });
  const sendStateRef = useRef({ resolveBackpressure: null, fileCounter: 0 });
  const speedRef = useRef({ lastBytes: 0, lastTime: Date.now() });
  const iceCandidateBufferRef = useRef([]);
  const remoteDescSetRef = useRef(false);
  const doneRef = useRef(false); // prevents false errors after transfer completes

  // ── Create peer connection ──────────────────────────────────────────────────
  function createPC() {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) sendIceCandidate(candidate);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === "connected") {
        onStatusChange("connected");
      } else if (["disconnected", "failed", "closed"].includes(state)) {
        // Don't fire error if the transfer already finished normally
        if (!doneRef.current) {
          onError("Peer disconnected. The other browser may have closed.");
        }
      }
    };

    pcRef.current = pc;
    return pc;
  }

  // ── Flush buffered ICE candidates ───────────────────────────────────────────
  async function flushIceCandidates() {
    const pc = pcRef.current;
    if (!pc) return;
    for (const candidate of iceCandidateBufferRef.current) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        /* stale candidate */
      }
    }
    iceCandidateBufferRef.current = [];
  }

  function sendIdentity(channel) {
    if (localNameRef.current) {
      channel.send(JSON.stringify({ type: "identity", name: localNameRef.current }));
    }
  }

  // ── Sender: initiate offer ──────────────────────────────────────────────────
  const initiateOffer = useCallback(async () => {
    const pc = createPC();
    const channel = pc.createDataChannel("securedrop-payload", { ordered: true });
    channel.binaryType = "arraybuffer";
    channelRef.current = channel;

    channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;

    channel.onbufferedamountlow = () => {
      const resolve = sendStateRef.current.resolveBackpressure;
      if (resolve) {
        sendStateRef.current.resolveBackpressure = null;
        resolve();
      }
    };

    channel.onopen = () => {
      onStatusChange("connected");
      sendIdentity(channel);
    };

    // Sender receives identity from receiver
    channel.onmessage = ({ data }) => {
      if (typeof data === "string") {
        try {
          const msg = JSON.parse(data);
          if (msg.type === "identity") onIdentity?.(msg.name);
        } catch {
          /* ignore */
        }
      }
    };

    channel.onerror = () => {
      if (!doneRef.current) onError("DataChannel error on sender side.");
    };
    channel.onclose = () => {
      if (!doneRef.current) onStatusChange("channel-closed");
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendOffer(offer);
  }, [sendOffer]);

  // ── Receiver: handle incoming offer ─────────────────────────────────────────
  const handleOffer = useCallback(
    async (offer) => {
      const pc = createPC();

      pc.ondatachannel = ({ channel }) => {
        channel.binaryType = "arraybuffer";
        channelRef.current = channel;

        channel.onopen = () => {
          onStatusChange("connected");
          sendIdentity(channel);
        };

        channel.onmessage = async ({ data }) => {
          // ── JSON control messages ─────────────────────────────────────
          if (typeof data === "string") {
            try {
              const msg = JSON.parse(data);

              if (msg.type === "identity") {
                onIdentity?.(msg.name);
                return;
              }

              if (msg.type === "file-meta") {
                doneRef.current = false; // new batch starting
                receiveStateRef.current.currentFile = {
                  index: msg.index,
                  filename: msg.filename,
                  type: msg.fileType,
                  totalSize: msg.size,
                  hash: msg.hash,
                  chunks: [],
                  bytesReceived: 0,
                };
                speedRef.current = { lastBytes: 0, lastTime: Date.now() };
                onStatusChange("receiving");
                return;
              }

              if (msg.type === "file-complete") {
                const file = receiveStateRef.current.currentFile;
                if (!file) return;

                const allChunks = file.chunks.map((c) => new Uint8Array(c));
                const totalBytes = allChunks.reduce((s, c) => s + c.byteLength, 0);
                const merged = new Uint8Array(totalBytes);
                let offset = 0;
                for (const chunk of allChunks) {
                  merged.set(chunk, offset);
                  offset += chunk.byteLength;
                }

                const blob = new Blob([merged], { type: file.type });
                const actualHash = await sha256Hex(merged.buffer);
                const verified = actualHash === file.hash;

                onFileComplete?.({
                  index: file.index,
                  filename: file.filename,
                  blob,
                  verified,
                  size: file.totalSize,
                });
                receiveStateRef.current.currentFile = null;
                return;
              }

              if (msg.type === "all-complete") {
                doneRef.current = true;
                onAllComplete?.();
                onStatusChange("done");
                return;
              }
            } catch {
              /* ignore malformed JSON */
            }
            return;
          }

          // ── Binary chunk — decrypt ─────────────────────────────────────
          const file = receiveStateRef.current.currentFile;
          if (!file) return;

          try {
            const plain = await decryptChunk(cryptoKeyRef.current, data);
            file.chunks.push(plain);
            file.bytesReceived += plain.byteLength;

            const now = Date.now();
            const elapsed = (now - speedRef.current.lastTime) / 1000;
            const speed =
              elapsed > 0
                ? (file.bytesReceived - speedRef.current.lastBytes) / elapsed
                : 0;
            speedRef.current = { lastBytes: file.bytesReceived, lastTime: now };

            onFileProgress?.({
              fileIndex: file.index,
              filename: file.filename,
              received: file.bytesReceived,
              total: file.totalSize,
              speed,
            });
          } catch {
            onError("Decryption failed. File may be corrupted.");
          }
        };

        channel.onerror = () => {
          if (!doneRef.current) onError("DataChannel error on receiver side.");
        };
        channel.onclose = () => {
          if (doneRef.current) return; // transfer finished, close is expected
          const file = receiveStateRef.current.currentFile;
          if (file && file.bytesReceived < file.totalSize) {
            onError("Connection closed before transfer completed.");
          } else {
            onStatusChange("channel-closed");
          }
        };
      };

      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      remoteDescSetRef.current = true;
      await flushIceCandidates();

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendAnswer(answer);
    },
    [sendAnswer]
  );

  // ── Handle answer (sender side) ─────────────────────────────────────────────
  const handleAnswer = useCallback(async (answer) => {
    const pc = pcRef.current;
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    remoteDescSetRef.current = true;
    await flushIceCandidates();
  }, []);

  // ── Handle ICE candidate ────────────────────────────────────────────────────
  const handleIceCandidate = useCallback(async (candidate) => {
    if (!candidate) return;
    if (!remoteDescSetRef.current) {
      iceCandidateBufferRef.current.push(candidate);
      return;
    }
    try {
      await pcRef.current?.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {
      /* stale candidate */
    }
  }, []);

  // ── Send multiple files sequentially ────────────────────────────────────────
  const sendFiles = useCallback(
    async (files, cryptoKey) => {
      const channel = channelRef.current;
      if (!channel || channel.readyState !== "open") {
        onError("DataChannel is not open yet.");
        return;
      }

      try {
        const startIndex = sendStateRef.current.fileCounter;

        for (let i = 0; i < files.length; i++) {
          const globalIndex = startIndex + i;
          const file = files[i];
          onStatusChange("hashing");

          const fileBuffer = await file.arrayBuffer();
          const fileHash = await sha256Hex(fileBuffer);

          // Guard: channel may have closed while we were hashing
          if (channel.readyState !== "open") {
            onError("Connection lost while preparing files.");
            return;
          }

          // Send file metadata
          channel.send(
            JSON.stringify({
              type: "file-meta",
              index: globalIndex,
              filename: file.name,
              size: file.size,
              fileType: file.type || "application/octet-stream",
              hash: fileHash,
            })
          );

          onStatusChange("sending");

          let bytesSent = 0;
          speedRef.current = { lastBytes: 0, lastTime: Date.now() };

          // Chunked send with backpressure + encryption
          for (let offset = 0; offset < fileBuffer.byteLength; offset += CHUNK_SIZE) {
            // Guard: check channel is still open before each chunk
            if (channel.readyState !== "open") {
              onError("Connection lost during transfer.");
              return;
            }

            const slice = fileBuffer.slice(offset, offset + CHUNK_SIZE);
            const encrypted = await encryptChunk(cryptoKey, slice);

            if (channel.bufferedAmount > BUFFERED_AMOUNT_HIGH) {
              await new Promise((resolve) => {
                sendStateRef.current.resolveBackpressure = resolve;
              });
            }

            channel.send(encrypted);

            bytesSent += slice.byteLength;
            const now = Date.now();
            const elapsed = (now - speedRef.current.lastTime) / 1000;
            const speed =
              elapsed > 0 ? (bytesSent - speedRef.current.lastBytes) / elapsed : 0;
            speedRef.current = { lastBytes: bytesSent, lastTime: now };

            onFileProgress?.({
              fileIndex: globalIndex,
              filename: file.name,
              sent: bytesSent,
              total: file.size,
              speed,
            });
          }

          // Mark this file as complete
          channel.send(JSON.stringify({ type: "file-complete", index: globalIndex }));
        }

        sendStateRef.current.fileCounter = startIndex + files.length;

        // All files sent — notify receiver, but sender stays connected
        channel.send(JSON.stringify({ type: "all-complete" }));
        onAllComplete?.();
      } catch (err) {
        // Catch any send errors from a closed channel
        if (!doneRef.current) {
          onError("Connection lost during transfer.");
        }
      }
    },
    [onFileProgress, onAllComplete, onStatusChange, onError]
  );

  // ── Attach crypto key (for receiver decryption) ─────────────────────────────
  const attachKeyToChannel = useCallback((cryptoKey) => {
    cryptoKeyRef.current = cryptoKey;
  }, []);

  // ── Set local user name for identity exchange ───────────────────────────────
  const setLocalName = useCallback((name) => {
    localNameRef.current = name;
  }, []);

  // ── Cleanup ─────────────────────────────────────────────────────────────────
  function cleanup() {
    channelRef.current?.close();
    pcRef.current?.close();
    channelRef.current = null;
    pcRef.current = null;
    remoteDescSetRef.current = false;
    iceCandidateBufferRef.current = [];
    // Resolve any pending backpressure promise so the send loop doesn't hang
    const resolve = sendStateRef.current.resolveBackpressure;
    if (resolve) {
      sendStateRef.current.resolveBackpressure = null;
      resolve();
    }
  }

  const close = useCallback(cleanup, []);

  return {
    initiateOffer,
    handleOffer,
    handleAnswer,
    handleIceCandidate,
    sendFiles,
    attachKeyToChannel,
    setLocalName,
    close,
  };
}
