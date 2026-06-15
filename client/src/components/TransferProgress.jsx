/**
 * TransferProgress.jsx — Live transfer dashboard for P2PShare
 *
 * Renders a per-file progress bar with real-time speed and integrity
 * status. Once a file finishes, we show whether the SHA-256 hash matched
 * (verified ✓) or if something went wrong during transit (mismatch ⚠).
 * This gives both sender and receiver immediate confidence that the
 * end-to-end encrypted transfer completed correctly.
 */

import { humanFileSize, humanTransferSpeed } from "../utils/format";


/**
 * @param {Object} fileProgress   — keyed by file index; each value has filename, transferred, total, speed
 * @param {Array}  completedFiles — entries for files that finished: { index, filename, blob?, verified, size }
 * @param {string} phase          — current transfer lifecycle stage (hashing | sending | receiving | done)
 */
export default function TransferProgress({
  fileProgress,
  completedFiles,
  phase,
}) {
  const entries = Object.entries(fileProgress);
  const doneCount = completedFiles.length;

  return (
    <div className="progress-card">
      <div className="progress-card-header">
        <span className="progress-label">
          {phase === "hashing"
            ? "Preparing files…"
            : phase === "done"
              ? `All ${entries.length} file(s) transferred`
              : `Transferring — ${doneCount} / ${entries.length} complete`}
        </span>
      </div>

      <div className="progress-files-list">
        {entries.map(([idx, fp]) => {
          const completed = completedFiles.find(
            (cf) => cf.index === Number(idx)
          );
          const pct =
            fp.total > 0
              ? Math.min(
                  100,
                  Math.round(
                    ((completed ? fp.total : fp.transferred) / fp.total) * 100
                  )
                )
              : 0;

          return (
            <div key={idx} className="file-progress">
              <div className="file-progress-header">
                <span className="file-progress-name" title={fp.filename}>
                  📄 {fp.filename}
                </span>
                <span className="file-progress-meta">
                  {completed
                    ? completed.verified
                      ? "Verified ✓"
                      : "Hash mismatch ⚠"
                    : `${humanFileSize(fp.transferred)} / ${humanFileSize(fp.total)}`}
                </span>
              </div>

              <div
                className="progress-bar-track"
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className={`progress-bar-fill ${completed ? (completed.verified ? "verified" : "mismatch") : ""}`}
                  style={{ width: pct + "%" }}
                />
              </div>

              <div className="file-progress-footer">
                {!completed && fp.speed > 0 && (
                  <span className="progress-speed">
                    {humanTransferSpeed(fp.speed)}
                  </span>
                )}
                {!completed && (
                  <span className="progress-pct">{pct}%</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
