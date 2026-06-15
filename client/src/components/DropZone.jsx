/**
 * DropZone.jsx — File selection surface for the sender side of P2PShare.
 *
 * Supports both drag-and-drop and a click-to-browse fallback. We enforce a
 * per-file size cap here so oversized files are caught early, before we
 * waste time hashing or opening a data channel for them.
 */
import { useState, useRef } from "react";

// 50 MB ceiling keeps WebRTC chunk transfers manageable on typical connections
const MAX_SIZE = 50 * 1024 * 1024;


export default function DropZone({ onFiles, disabled }) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);

  function handleFiles(fileList) {
    setError("");
    if (!fileList || fileList.length === 0) return;

    const files = Array.from(fileList);
    const oversized = files.filter((f) => f.size > MAX_SIZE);
    if (oversized.length > 0) {
      setError(
        `${oversized.length} file(s) exceed 50 MB limit and were skipped.`
      );
      const valid = files.filter((f) => f.size <= MAX_SIZE);
      if (valid.length > 0) onFiles(valid);
      return;
    }
    onFiles(files);
  }

  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    if (!disabled) handleFiles(e.dataTransfer.files);
  }

  function onDragOver(e) {
    e.preventDefault();
    if (!disabled) setDragging(true);
  }

  function onDragLeave() {
    setDragging(false);
  }

  function onInputChange(e) {
    handleFiles(e.target.files);
    e.target.value = "";
  }

  return (
    <div className="dropzone-wrapper">
      <div
        className={`dropzone ${dragging ? "dragging" : ""} ${disabled ? "disabled" : ""}`}
        onDrop={disabled ? undefined : onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={() => !disabled && inputRef.current?.click()}
        role="button"
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) =>
          e.key === "Enter" && !disabled && inputRef.current?.click()
        }
        aria-label="Drop files here or click to choose"
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={onInputChange}
          aria-hidden="true"
        />
        <div className="dropzone-icon">
          <svg
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </div>
        <p className="dropzone-text">
          {disabled
            ? "Waiting for receiver to connect…"
            : "Drop your files here"}
        </p>
        {!disabled && (
          <p className="dropzone-subtext">
            or click to browse · multiple files · max 50 MB each
          </p>
        )}
      </div>
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}
