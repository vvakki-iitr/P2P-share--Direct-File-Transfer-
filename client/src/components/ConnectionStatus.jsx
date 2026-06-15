/**
 * ConnectionStatus.jsx — Peer connection indicator for P2PShare
 *
 * Maps our internal connection + transfer states to a simple colored dot
 * and a human-readable label. The state keys cover both the WebRTC
 * lifecycle (connecting → connected → disconnected) and the file transfer
 * phases (hashing → sending/receiving → done) so the user always knows
 * what's happening under the hood.
 */

const STATE_CONFIG = {
  idle: { dot: "dot-idle", text: "Not connected" },
  connecting: { dot: "dot-connecting", text: "Connecting…" },
  connected: { dot: "dot-connected", text: "Connected — encrypted P2P" },
  "channel-closed": { dot: "dot-idle", text: "Channel closed" },
  disconnected: { dot: "dot-error", text: "Disconnected" },
  failed: { dot: "dot-error", text: "Connection failed" },
  closed: { dot: "dot-idle", text: "Connection closed" },
  hashing: { dot: "dot-connected", text: "Computing hash…" },
  sending: { dot: "dot-connected", text: "Sending" },
  receiving: { dot: "dot-connected", text: "Receiving" },
  done: { dot: "dot-connected", text: "Done" },
};

export default function ConnectionStatus({ status }) {
  const config = STATE_CONFIG[status] ?? { dot: "dot-idle", text: status };

  return (
    <div className="conn-status">
      <span className={`dot ${config.dot}`} aria-hidden="true" />
      <span className="conn-text">{config.text}</span>
    </div>
  );
}
