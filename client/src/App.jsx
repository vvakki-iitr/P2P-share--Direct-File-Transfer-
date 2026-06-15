/**
 * App.jsx — SecureDrop Main Application
 *
 * This is the root component that orchestrates the entire P2P file sharing workflow.
 * It manages the user's authentication state, room creation via the signaling server,
 * WebRTC peer connection lifecycle, and the file transfer UI for both sender and receiver.
 *
 * The design follows a phase-based state machine:
 *   idle → creating → room-created → connecting → connected → sending/receiving → done
 *
 * Encryption keys are generated client-side and embedded in the URL fragment,
 * ensuring the server never has access to the decryption key (zero-knowledge).
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { useSocket } from "./hooks/useSocket";
import { useWebRTC } from "./hooks/useWebRTC";
import { generateKey, importKey } from "./utils/crypto";
import { humanFileSize, friendlyDate } from "./utils/format";
import DropZone from "./components/DropZone";
import TransferProgress from "./components/TransferProgress";
import ConnectionStatus from "./components/ConnectionStatus";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";
const STORAGE_USER_KEY = "p2pshare_user";
const STORAGE_RECEIVER_NAME_KEY = "p2pshare_receiver_name";

// ─── URL helpers ──────────────────────────────────────────────────────────────
function parseUrlHash() {
  const hash = window.location.hash.slice(1);
  const params = new URLSearchParams(hash);
  return {
    roomId: params.get("room"),
    keyB64: params.get("key"),
    senderName: params.get("from") || "",
  };
}

function buildShareLink(roomId, keyB64, senderName) {
  return `${window.location.origin}/#room=${roomId}&key=${encodeURIComponent(keyB64)}&from=${encodeURIComponent(senderName)}`;
}

// ─── History helpers (keyed by user id) ───────────────────────────────────────
function historyKey(userId) {
  return `p2pshare_history_${userId}`;
}

function getHistory(userId) {
  if (!userId) return [];
  try {
    return JSON.parse(localStorage.getItem(historyKey(userId)) || "[]");
  } catch {
    return [];
  }
}

function addHistoryEntry(userId, entry) {
  const history = getHistory(userId);
  history.unshift(entry);
  if (history.length > 50) history.length = 50;
  localStorage.setItem(historyKey(userId), JSON.stringify(history));
}

// ──────────────────────────────────────────────────────────────────────────────
export default function App() {
  const { roomId: urlRoomId, keyB64: urlKeyB64, senderName: urlSenderName } =
    parseUrlHash();
  const isReceiver = Boolean(urlRoomId);

  // ── Auth state (sender only) ────────────────────────────────────────────────
  const [user, setUser] = useState(null);
  const [authMode, setAuthMode] = useState("login"); // "login" | "register"
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  const isLoggedIn = Boolean(user);

  // ── Receiver name state (simple prompt, no login) ───────────────────────────
  const [receiverName, setReceiverName] = useState("");
  const [receiverNameInput, setReceiverNameInput] = useState("");
  const [showReceiverPrompt, setShowReceiverPrompt] = useState(isReceiver);

  // ── Core state ──────────────────────────────────────────────────────────────
  const [phase, setPhase] = useState("idle");
  const [status, setStatus] = useState("idle");
  const [shareLink, setShareLink] = useState("");
  const [files, setFiles] = useState([]);
  const [copied, setCopied] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [peerName, setPeerName] = useState(
    urlSenderName ? decodeURIComponent(urlSenderName) : ""
  );

  // ── Multi-file tracking ─────────────────────────────────────────────────────
  const [fileProgress, setFileProgress] = useState({});
  const [completedFiles, setCompletedFiles] = useState([]);
  const [history, setHistory] = useState(() => getHistory(user?.id));

  const cryptoKeyRef = useRef(null);
  const hasSentRef = useRef(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const filesRef = useRef(files);
  filesRef.current = files;
  const downloadedRef = useRef(new Set());
  const [successMsg, setSuccessMsg] = useState("");

  // ── Auth functions ──────────────────────────────────────────────────────────
  async function handleAuth(e) {
    e.preventDefault();
    setAuthError("");
    setAuthLoading(true);

    const form = new FormData(e.target);
    const name = form.get("name")?.trim();
    const password = form.get("password")?.trim();
    const email = form.get("email")?.trim();

    try {
      const endpoint =
        authMode === "register" ? "/auth/register" : "/auth/login";
      const body =
        authMode === "register"
          ? { name, email, password }
          : { name, password };

      const res = await fetch(`${SERVER_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Authentication failed.");

      localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(data.user));
      setUser(data.user);
      setHistory(getHistory(data.user.id));
    } catch (err) {
      setAuthError(err.message);
    } finally {
      setAuthLoading(false);
    }
  }

  function logout() {
    localStorage.removeItem(STORAGE_USER_KEY);
    setUser(null);
    setHistory([]);
    setPhase("idle");
  }

  // ── Global drag & drop prevention ───────────────────────────────────────────
  useEffect(() => {
    function preventGlobal(e) {
      e.preventDefault();
    }
    window.addEventListener("dragover", preventGlobal);
    window.addEventListener("drop", preventGlobal);
    return () => {
      window.removeEventListener("dragover", preventGlobal);
      window.removeEventListener("drop", preventGlobal);
    };
  }, []);

  // ── WebRTC callbacks ────────────────────────────────────────────────────────
  const handleFileProgress = useCallback(
    ({ fileIndex, filename, sent, received, total, speed }) => {
      setFileProgress((prev) => ({
        ...prev,
        [fileIndex]: {
          filename,
          transferred: sent ?? received ?? 0,
          total,
          speed,
        },
      }));
    },
    []
  );

  // ── Staggered auto-download queue (avoids Chrome's multi-download block) ────
  const downloadQueueRef = useRef([]);
  const downloadingRef = useRef(false);

  function processDownloadQueue() {
    if (downloadingRef.current || downloadQueueRef.current.length === 0) return;
    downloadingRef.current = true;
    const { blob, filename } = downloadQueueRef.current.shift();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Wait before next download to avoid Chrome blocking
    setTimeout(() => {
      downloadingRef.current = false;
      processDownloadQueue();
    }, 1000);
  }

  const handleFileComplete = useCallback(
    ({ index, filename, blob, verified, size }) => {
      setCompletedFiles((prev) => {
        if (prev.find((f) => f.index === index)) return prev;
        return [...prev, { index, filename, blob, verified, size, timestamp: Date.now() }];
      });

      // Auto-download on receiver only, queued to avoid Chrome blocking
      if (isReceiver && blob && !downloadedRef.current.has(index)) {
        downloadedRef.current.add(index);
        downloadQueueRef.current.push({ blob, filename });
        processDownloadQueue();
      }
    },
    [isReceiver]
  );

  const handleAllComplete = useCallback(() => {
    if (isReceiver) {
      setPhase("done");
      setStatus("done");
    } else {
      // Sender: save history, show success, stay connected for more
      if (user?.id) {
        addHistoryEntry(user.id, {
          id: Date.now().toString(),
          date: new Date().toISOString(),
          files: filesRef.current.map((f) => ({ name: f.name, size: f.size })),
          receiverName: peerName || "Unknown",
        });
        setHistory(getHistory(user.id));
      }
      const count = filesRef.current.length;
      setSuccessMsg(`✓ ${count} file${count !== 1 ? "s" : ""} sent successfully`);
      setTimeout(() => setSuccessMsg(""), 4000);
      setFiles([]);
      setFileProgress({});
      setCompletedFiles([]);
      hasSentRef.current = false;
      setPhase("connected");
      setStatus("connected");
    }
  }, [isReceiver, user, peerName]);

  const handleStatusChange = useCallback((s) => {
    setStatus(s);
    if (s === "connected") {
      setPhase((prev) => {
        if (["room-created", "connecting", "waiting"].includes(prev))
          return "connected";
        return prev;
      });
    }
    if (s === "sending" || s === "receiving") setPhase(s);
    if (s === "done") setPhase("done");
  }, []);

  const handleError = useCallback((msg) => {
    setErrorMsg(typeof msg === "object" ? msg.message : String(msg));
    setPhase("error");
    setStatus("failed");
  }, []);

  const handleIdentity = useCallback((name) => {
    setPeerName(name);
  }, []);

  // ── WebRTC hook ─────────────────────────────────────────────────────────────
  const {
    initiateOffer,
    handleOffer,
    handleAnswer,
    handleIceCandidate,
    sendFiles: rtcSendFiles,
    attachKeyToChannel,
    setLocalName,
    close: closeRTC,
  } = useWebRTC({
    sendOffer: (...args) => socketActions.sendOffer(...args),
    sendAnswer: (...args) => socketActions.sendAnswer(...args),
    sendIceCandidate: (...args) => socketActions.sendIceCandidate(...args),
    onFileProgress: handleFileProgress,
    onFileComplete: handleFileComplete,
    onAllComplete: handleAllComplete,
    onStatusChange: handleStatusChange,
    onError: handleError,
    onIdentity: handleIdentity,
  });

  // ── Socket hook ─────────────────────────────────────────────────────────────
  const socketActions = useSocket({
    onRoomJoined: ({ isInitiator }) => {
      if (isReceiver && !isInitiator) {
        setPhase("waiting");
        setStatus("connecting");
      }
    },
    onPeerJoined: async () => {
      setPhase("connecting");
      setStatus("connecting");
      await initiateOffer();
    },
    onPeerLeft: () => {
      if (phaseRef.current !== "done") {
        setErrorMsg("The other peer disconnected.");
        setPhase("disconnected");
        setStatus("disconnected");
      }
      closeRTC();
    },
    onOffer: async (offer) => await handleOffer(offer),
    onAnswer: async (answer) => await handleAnswer(answer),
    onIceCandidate: async (candidate) => await handleIceCandidate(candidate),
    onError: (err) => {
      setErrorMsg(err.message || String(err));
      setPhase("error");
    },
    onSocketDisconnect: (reason) => {
      if (
        ["room-created", "connecting", "waiting"].includes(phaseRef.current)
      ) {
        setErrorMsg("Lost connection to signaling server.");
        setPhase("error");
        setStatus("disconnected");
      }
    },
  });

  // ── Set name on WebRTC hook (sender: from user profile, receiver: from name prompt)
  useEffect(() => {
    if (!isReceiver && user?.name) setLocalName(user.name);
    if (isReceiver && receiverName) setLocalName(receiverName);
  }, [user, receiverName, setLocalName, isReceiver]);

  // ── Receiver: join room after name prompt is completed ──────────────────────
  useEffect(() => {
    if (!isReceiver || showReceiverPrompt) return;

    (async () => {
      if (!urlKeyB64) {
        setErrorMsg("No encryption key in URL. The link may be incomplete.");
        setPhase("error");
        return;
      }
      try {
        const key = await importKey(urlKeyB64);
        cryptoKeyRef.current = key;
        attachKeyToChannel(key);
        setPhase("waiting");
        socketActions.joinRoom(urlRoomId);
      } catch {
        setErrorMsg("Invalid encryption key in URL.");
        setPhase("error");
      }
    })();
  }, [showReceiverPrompt]);

  // ── Sender: auto-send when connected and files are queued ───────────────────
  useEffect(() => {
    if (
      !isReceiver &&
      status === "connected" &&
      files.length > 0 &&
      cryptoKeyRef.current &&
      !hasSentRef.current
    ) {
      hasSentRef.current = true;
      setPhase("sending");
      rtcSendFiles(files, cryptoKeyRef.current);
    }
  }, [status, files, isReceiver]);

  // ── Create room ─────────────────────────────────────────────────────────────
  async function createRoom() {
    setPhase("creating");
    setErrorMsg("");
    try {
      const res = await fetch(`${SERVER_URL}/room`, { method: "POST" });
      if (!res.ok) throw new Error("Server error");
      const { roomId } = await res.json();

      const { key, keyB64 } = await generateKey();
      cryptoKeyRef.current = key;

      setShareLink(buildShareLink(roomId, keyB64, user?.name || ""));
      setPhase("room-created");

      socketActions.joinRoom(roomId);
    } catch {
      setErrorMsg("Could not reach the signaling server. Is it running?");
      setPhase("error");
    }
  }

  function onFilesSelected(newFiles) {
    setFiles((prev) => [...prev, ...newFiles]);
  }

  function removeFile(index) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareLink);
    } catch {
      const el = document.createElement("textarea");
      el.value = shareLink;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // ── Reset transfer state (keeps user logged in) ─────────────────────────────
  function resetTransfer() {
    closeRTC();
    setPhase("idle");
    setStatus("idle");
    setShareLink("");
    setFiles([]);
    setCopied(false);
    setErrorMsg("");
    setPeerName("");
    setFileProgress({});
    setCompletedFiles([]);
    hasSentRef.current = false;
    // Refresh history
    if (user?.id) setHistory(getHistory(user.id));
    // Clear URL hash so it doesn't look like a receiver link
    window.location.hash = "";
  }

  // ── Render helpers ──────────────────────────────────────────────────────────
  const inTransfer = ["hashing", "sending", "receiving"].includes(phase);
  const isDone = phase === "done";
  const isError = phase === "error" || phase === "disconnected";

  // ── Receiver name prompt (simple, not a login) ──────────────────────────────
  function submitReceiverName(e) {
    e.preventDefault();
    const name = receiverNameInput.trim();
    if (!name) return;
    localStorage.setItem(STORAGE_RECEIVER_NAME_KEY, name);
    setReceiverName(name);
    setShowReceiverPrompt(false);
  }

  if (showReceiverPrompt) {
    return (
      <div className="app">
        <div className="name-overlay">
          <div className="auth-card">
            <div className="name-card-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </div>
            <h2>{peerName ? `${peerName} shared files with you` : "Incoming Files"}</h2>
            <p className="muted">Enter your name so the sender knows who received the files</p>
            <form onSubmit={submitReceiverName} className="auth-form">
              <input
                className="auth-input"
                type="text"
                placeholder="Your name"
                value={receiverNameInput}
                onChange={(e) => setReceiverNameInput(e.target.value)}
                autoFocus
              />
              <button className="btn-primary auth-submit" type="submit" disabled={!receiverNameInput.trim()}>
                Continue
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // ── AUTH SCREEN (sender only — receiver never sees this) ────────────────────
  if (!isReceiver && !isLoggedIn) {
    return (
      <div className="app">
        <div className="name-overlay">
          <div className="auth-card">
            <div className="name-card-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="16 16 12 12 8 16" />
                <line x1="12" y1="12" x2="12" y2="21" />
                <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
              </svg>
            </div>
            <h2>P2P Share</h2>
            <p className="muted">
              {authMode === "register"
                ? "Create your profile to start sharing"
                : "Login to continue"}
            </p>

            {/* ── Tabs ── */}
            <div className="auth-tabs">
              <button
                className={`auth-tab ${authMode === "login" ? "active" : ""}`}
                onClick={() => {
                  setAuthMode("login");
                  setAuthError("");
                }}
                type="button"
              >
                Login
              </button>
              <button
                className={`auth-tab ${authMode === "register" ? "active" : ""}`}
                onClick={() => {
                  setAuthMode("register");
                  setAuthError("");
                }}
                type="button"
              >
                Create Profile
              </button>
            </div>

            {/* ── Form ── */}
            <form onSubmit={handleAuth} className="auth-form">
              <input
                className="auth-input"
                name="name"
                type="text"
                placeholder="Name"
                required
                autoFocus
                autoComplete="username"
              />
              {authMode === "register" && (
                <input
                  className="auth-input"
                  name="email"
                  type="email"
                  placeholder="Email"
                  required
                  autoComplete="email"
                />
              )}
              <input
                className="auth-input"
                name="password"
                type="password"
                placeholder="Password"
                required
                autoComplete={
                  authMode === "register" ? "new-password" : "current-password"
                }
              />
              {authError && <p className="field-error">{authError}</p>}
              <button
                className="btn-primary auth-submit"
                type="submit"
                disabled={authLoading}
              >
                {authLoading
                  ? "Please wait…"
                  : authMode === "login"
                    ? "Login"
                    : "Create Profile"}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // ── MAIN APP ────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <header className="app-header">
        <div className="logo">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="16 16 12 12 8 16" />
            <line x1="12" y1="12" x2="12" y2="21" />
            <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
          </svg>
          <span>P2P Share</span>
          {/* Sender: show user badge + logout · Receiver: show nothing */}
          {!isReceiver && user && (
            <>
              <span className="user-badge">{user.name}</span>
              <button className="btn-logout" onClick={logout} title="Logout">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
              </button>
            </>
          )}
        </div>
        <ConnectionStatus status={status} />
      </header>

      <main className="app-main">
        {/* ── Error / Disconnect ── */}
        {isError && (
          <div className="error-card">
            <div className="done-icon warn">
              {phase === "disconnected" ? "⚡" : "✕"}
            </div>
            <p className="error-title">
              {phase === "disconnected"
                ? "Peer disconnected"
                : "Something went wrong"}
            </p>
            <p className="error-body">{errorMsg}</p>
            <button
              className="btn-primary"
              onClick={isReceiver ? () => window.location.assign("/") : resetTransfer}
            >
              Start over
            </button>
          </div>
        )}

        {/* ────────────────────── SENDER ────────────────────── */}
        {!isReceiver && !isError && (
          <>
            {phase === "idle" && (
              <div className="sender-landing">
                <div className="hero">
                  <h1 className="hero-title">Send files directly</h1>
                  <p className="hero-sub">
                    Browser-to-browser · End-to-end encrypted
                    <br />
                    The server never sees your files
                  </p>
                  <button className="btn-primary" onClick={createRoom}>
                    Create share room
                  </button>
                </div>

                {history.length > 0 && (
                  <div className="history-section">
                    <h3 className="history-title">Transfer History</h3>
                    {history.map((h, i) => (
                      <div key={i} className="history-entry">
                        <div className="history-meta">
                          <span className="history-date">
                            {friendlyDate(h.date)}
                          </span>
                          <span className="history-receiver">
                            → {h.receiverName}
                          </span>
                        </div>
                        <div className="history-files">
                          {h.files.map((f, j) => (
                            <span key={j} className="history-file">
                              📄 {f.name}{" "}
                              <span className="muted">
                                ({humanFileSize(f.size)})
                              </span>
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {phase === "creating" && (
              <div className="hero">
                <p className="muted">Setting up your room…</p>
              </div>
            )}

            {["room-created", "connected", "connecting"].includes(phase) &&
              !inTransfer && (
                <div className="sender-ready">
                  {/* Success toast */}
                  {successMsg && (
                    <div className="success-toast">{successMsg}</div>
                  )}

                  {/* Disconnect button when connected */}
                  {phase === "connected" && (
                    <div className="connected-bar">
                      <span className="connected-peer">
                        🟢 Connected{peerName ? ` to ${peerName}` : ""}
                      </span>
                      <button className="btn-disconnect" onClick={resetTransfer}>
                        Disconnect
                      </button>
                    </div>
                  )}

                  <div className="share-section">
                    <p className="share-label">
                      Share this link with the recipient
                    </p>
                    <div className="share-link-row">
                      <input
                        className="share-input"
                        readOnly
                        value={shareLink}
                        onClick={(e) => e.target.select()}
                      />
                      <button className="btn-copy" onClick={copyLink}>
                        {copied ? "Copied!" : "Copy"}
                      </button>
                    </div>
                    <p className="share-hint">
                      🔒 Encryption key is in the URL fragment — never sent to
                      any server
                    </p>
                  </div>

                  <DropZone onFiles={onFilesSelected} disabled={false} />

                  {files.length > 0 && (
                    <div className="files-queue">
                      <p className="files-queue-title">
                        Files to send ({files.length})
                      </p>
                      {files.map((f, i) => (
                        <div key={i} className="file-queued">
                          <span className="file-queued-icon">📄</span>
                          <span className="file-queued-name">{f.name}</span>
                          <span className="file-queued-size">
                            {humanFileSize(f.size)}
                          </span>
                          <button
                            className="file-remove-btn"
                            onClick={() => removeFile(i)}
                            title="Remove"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                      {phase === "room-created" && (
                        <p className="muted small">
                          Will send when receiver connects
                        </p>
                      )}
                      {phase === "connected" && (
                        <p className="muted small">
                          Drop files and they'll be sent automatically
                        </p>
                      )}
                    </div>
                  )}

                  {phase === "room-created" && files.length === 0 && (
                    <p className="muted center">
                      Drop files above, then share the link
                    </p>
                  )}
                  {phase === "connected" && files.length === 0 && (
                    <p className="muted center">
                      Drop files to send to {peerName || "the receiver"}
                    </p>
                  )}
                </div>
              )}

            {inTransfer && (
              <TransferProgress
                fileProgress={fileProgress}
                completedFiles={completedFiles}
                phase={phase}
              />
            )}


          </>
        )}

        {/* ────────────────────── RECEIVER ────────────────────── */}
        {isReceiver && !isError && (
          <div className="receiver-view">
            <div className="receiver-header">
              <h1 className="receiver-title">
                {peerName ? `Files from ${peerName}` : "Incoming Files"}
              </h1>
              <div className="encryption-badge">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                End-to-end encrypted
              </div>
            </div>

            {/* Waiting state */}
            {["idle", "waiting", "connecting"].includes(phase) && (
              <div className="receiver-waiting">
                <div className="waiting-spinner" />
                <p className="muted">
                  Waiting for sender to start the transfer…
                </p>
              </div>
            )}

            {/* File cards */}
            {(inTransfer || isDone) && (
              <div className="receiver-files">
                {Object.entries(fileProgress).map(([idx, fp]) => {
                  const completed = completedFiles.find(
                    (cf) => cf.index === Number(idx)
                  );
                  const pct =
                    fp.total > 0
                      ? Math.min(
                          100,
                          Math.round(
                            ((completed ? fp.total : fp.transferred) /
                              fp.total) *
                              100
                          )
                        )
                      : 0;

                  return (
                    <div
                      key={idx}
                      className={`receiver-file-card ${completed ? "completed" : ""}`}
                    >
                      <div className="receiver-file-info">
                        <span className="receiver-file-icon">
                          {completed
                            ? completed.verified
                              ? "✅"
                              : "⚠️"
                            : "📄"}
                        </span>
                        <div className="receiver-file-details">
                          <span className="receiver-file-name">
                            {fp.filename}
                          </span>
                          <span className="receiver-file-meta">
                            {completed
                              ? `${humanFileSize(fp.total)} · ${new Date(completed.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${new Date(completed.timestamp).toLocaleDateString()} · ${completed.verified ? "Verified" : "Hash mismatch!"}`
                              : `${humanFileSize(fp.transferred)} / ${humanFileSize(fp.total)}`}
                          </span>
                        </div>
                        {completed && completed.blob && (
                          <button
                            className="btn-download"
                            onClick={async () => {
                              if (navigator.share) {
                                try {
                                  const file = new File([completed.blob], completed.filename, { type: completed.blob.type });
                                  await navigator.share({
                                    files: [file],
                                    title: completed.filename,
                                  });
                                } catch (err) {
                                  console.error("Share failed", err);
                                }
                              } else {
                                alert("Web Share API is not supported on this browser.");
                              }
                            }}
                          >
                            ➦ Share
                          </button>
                        )}
                      </div>
                      {!completed && (
                        <div className="progress-bar-track">
                          <div
                            className="progress-bar-fill"
                            style={{ width: pct + "%" }}
                          />
                        </div>
                      )}
                      {completed && completed.verified === false && (
                        <p className="file-warn">
                          File hash does not match. It may be corrupted.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {isDone && (
              <div className="receiver-done">
                <p className="done-msg">✓ All files received and verified</p>
              </div>
            )}
          </div>
        )}
      </main>

      <footer className="app-footer">
        <p>Files never touch the server · End-to-end encrypted · Open source</p>
      </footer>
    </div>
  );
}
