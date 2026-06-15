/**
 * server/index.js — Signaling & auth server for P2PShare
 *
 * This server has two jobs:
 *   1. Lightweight user auth (register/login) backed by a local JSON file.
 *   2. WebRTC signaling relay — we forward SDP offers/answers and ICE
 *      candidates between peers via Socket.io, but we NEVER inspect or
 *      store the actual file data or the encryption key. That's the
 *      whole zero-knowledge idea behind this project.
 *
 * Rooms are ephemeral (in-memory, auto-pruned) because transfers are
 * short-lived. No database required for the MVP.
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { nanoid } = require("nanoid");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 4000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
const MAX_ROOM_AGE_MS = 2 * 60 * 60 * 1000; // auto-expire rooms after 2 hours
const USERS_FILE = path.join(__dirname, "users.json");
app.use(cors({ origin: "*" }));
app.use(express.json());

// We're using a flat JSON file for user storage — simple enough for a college
// project demo. In production you'd swap this for a real database.
function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Password hashing with scrypt — built into Node so we avoid adding bcrypt
// as a native dependency. Each password gets its own random salt.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const test = crypto.scryptSync(password, salt, 64).toString("hex");
  return test === hash;
}

// Rooms live in memory only — they're just rendezvous points for two peers.
// No reason to persist them since transfers are one-shot.
const rooms = new Map();

// Sweep expired rooms every 30 min so abandoned rooms don't leak memory
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    if (now - room.createdAt > MAX_ROOM_AGE_MS) {
      rooms.delete(roomId);
    }
  }
}, 30 * 60 * 1000);

// ─── Auth routes ──────────────────────────────────────────────────────────────
app.post("/auth/register", (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: "All fields are required." });
  }
  if (name.trim().length < 2) {
    return res.status(400).json({ error: "Name must be at least 2 characters." });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: "Password must be at least 4 characters." });
  }

  const users = loadUsers();

  if (users.find((u) => u.name.toLowerCase() === name.trim().toLowerCase())) {
    return res.status(409).json({ error: "Username already taken." });
  }
  if (users.find((u) => u.email.toLowerCase() === email.trim().toLowerCase())) {
    return res.status(409).json({ error: "Email already registered." });
  }

  const user = {
    id: nanoid(12),
    name: name.trim(),
    email: email.trim().toLowerCase(),
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };

  users.push(user);
  saveUsers(users);

  res.json({ user: { id: user.id, name: user.name, email: user.email } });
});


app.post("/auth/login", (req, res) => {
  const { name, password } = req.body;

  if (!name || !password) {
    return res.status(400).json({ error: "Name and password are required." });
  }

  const users = loadUsers();
  const user = users.find(
    (u) => u.name.toLowerCase() === name.trim().toLowerCase()
  );

  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: "Invalid name or password." });
  }

  res.json({ user: { id: user.id, name: user.name, email: user.email } });
});

// The sender hits this endpoint to mint a fresh room ID before sharing the link
app.post("/room", (req, res) => {
  const roomId = nanoid(10);
  rooms.set(roomId, { peers: [], createdAt: Date.now() });
  res.json({ roomId });
});


app.get("/health", (req, res) => res.json({ ok: true }));

// ─── WebRTC signaling over Socket.io ──────────────────────────────────────────
// This is the heart of the server: we relay SDP and ICE messages so two
// browsers can establish a direct peer connection. We intentionally never
// look at the payload contents — we're just a dumb pipe.
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

io.on("connection", (socket) => {
  let currentRoom = null;


  socket.on("join-room", (roomId) => {
    const room = rooms.get(roomId);

    if (!room) {
      socket.emit("error", { code: "ROOM_NOT_FOUND", message: "Room does not exist." });
      return;
    }

    // Guard against ghost socket IDs from crashed tabs
    room.peers = room.peers.filter((id) => io.sockets.sockets.has(id));

    if (room.peers.length >= 2) {
      socket.emit("error", { code: "ROOM_FULL", message: "Room already has two peers." });
      return;
    }


    if (room.peers.includes(socket.id)) {
      socket.emit("error", { code: "ALREADY_JOINED", message: "Already in this room." });
      return;
    }

    room.peers.push(socket.id);
    currentRoom = roomId;
    socket.join(roomId);

    const isInitiator = room.peers.length === 1;
    socket.emit("room-joined", { roomId, isInitiator });

    // Let the sender know the receiver showed up so it can start the offer
    if (!isInitiator) {
      const senderId = room.peers[0];
      io.to(senderId).emit("peer-joined");
    }
  });

  // Forward SDP and ICE messages to the other peer — pure relay, no inspection

  socket.on("offer", (payload) => {
    socket.to(currentRoom).emit("offer", payload);
  });

  socket.on("answer", (payload) => {
    socket.to(currentRoom).emit("answer", payload);
  });

  socket.on("ice-candidate", (candidate) => {
    socket.to(currentRoom).emit("ice-candidate", candidate);
  });


  socket.on("disconnect", () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;


    room.peers = room.peers.filter((id) => id !== socket.id);


    socket.to(currentRoom).emit("peer-left");

    // No peers left — reclaim the room
    if (room.peers.length === 0) {
      rooms.delete(currentRoom);
    }
  });
});


server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
