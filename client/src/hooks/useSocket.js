import { useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";

/**
 * Returns a stable socket instance and a joinRoom helper.
 * The socket connects once on mount and disconnects on unmount.
 */
export function useSocket(handlers) {
  const socketRef = useRef(null);
  // Keep handlers in a ref so callbacks don't cause re-subscriptions
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const socket = io(SERVER_URL, { transports: ["websocket"] });
    socketRef.current = socket;

    socket.on("room-joined", (data) => handlersRef.current.onRoomJoined?.(data));
    socket.on("peer-joined", () => handlersRef.current.onPeerJoined?.());
    socket.on("peer-left", () => handlersRef.current.onPeerLeft?.());
    socket.on("offer", (data) => handlersRef.current.onOffer?.(data));
    socket.on("answer", (data) => handlersRef.current.onAnswer?.(data));
    socket.on("ice-candidate", (c) => handlersRef.current.onIceCandidate?.(c));
    socket.on("error", (err) => handlersRef.current.onError?.(err));
    socket.on("connect_error", () =>
      handlersRef.current.onError?.({ code: "CONNECT_ERROR", message: "Cannot reach signaling server." })
    );

    // Graceful disconnect: if the socket itself drops (server down, network lost)
    socket.on("disconnect", (reason) => {
      handlersRef.current.onSocketDisconnect?.(reason);
    });
    socket.on("reconnect", () => {
      handlersRef.current.onSocketReconnect?.();
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  const joinRoom = useCallback((roomId) => {
    socketRef.current?.emit("join-room", roomId);
  }, []);

  const sendOffer = useCallback((offer) => {
    socketRef.current?.emit("offer", offer);
  }, []);

  const sendAnswer = useCallback((answer) => {
    socketRef.current?.emit("answer", answer);
  }, []);

  const sendIceCandidate = useCallback((candidate) => {
    socketRef.current?.emit("ice-candidate", candidate);
  }, []);

  return { joinRoom, sendOffer, sendAnswer, sendIceCandidate };
}
