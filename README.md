# SecureDrop — Zero-Knowledge P2P File Transfer

> **MARS OpenProjects 2026** — Peer-to-Peer Encrypted File Sharing Application

## 🔗 Official Links

| Resource | Link |
|---|---|
| **Live Web App** | [https://p2-p-share-direct-file-transfer.vercel.app/](https://p2-p-share-direct-file-transfer.vercel.app/) |
| **Backend API** | [https://p2p-share-direct-file-transfer.onrender.com](https://p2p-share-direct-file-transfer.onrender.com) |
| **Demo Video** | *[Insert YouTube / Google Drive link here later]* |

---

## ✦ Project Overview

SecureDrop is a browser-based file transfer tool that lets two users share files directly — peer-to-peer — without uploading anything to a server. Files are encrypted end-to-end using AES-GCM (256-bit) through the Web Crypto API, and the encryption key is embedded purely in the URL fragment (`#key=...`), meaning **even the signaling server never has access** to the raw data or the decryption key.

---

## ✦ Technology Stack

| Layer | Technology |
|---|---|
| **Frontend** | React.js (Vite), CSS |
| **P2P Communication** | Native WebRTC API (RTCPeerConnection + RTCDataChannel) |
| **Encryption** | Web Crypto API — AES-GCM 256-bit |
| **Backend Signaling** | Node.js + Express.js + Socket.io |
| **Hosting** | Vercel / Netlify (Frontend) · Render / Railway (Backend) |

---

## ✦ Setup Instructions

### Prerequisites
- [Node.js](https://nodejs.org/) v16 or later

### 1. Clone the Repository
```bash
git clone https://github.com/<your-username>/p2pshare.git
cd p2pshare
```

### 2. Install Dependencies

**Backend:**
```bash
cd server
npm install
```

**Frontend:**
```bash
cd client
npm install
```

### 3. Run Locally

**Start the signaling server** (Terminal 1):
```bash
cd server
node index.js
```
> Server runs on `http://localhost:4000`

**Start the React frontend** (Terminal 2):
```bash
cd client
npm run dev
```
> App runs on `http://localhost:5173`

### 4. Test the Transfer
1. Open `http://localhost:5173` in **two separate browser windows**
2. In Window A → Log in or create a profile → Click **"Start Sharing"**
3. Copy the generated share link
4. Paste the link in Window B → Enter your name as the receiver
5. In Window A → Drag-and-drop files into the drop zone
6. Watch the real-time progress bars and speed indicators on both sides
7. Files auto-download on the receiver's machine and display with verification status

---

## ✦ Feature List

| Feature | Description |
|---|---|
| **Drag-and-Drop Upload** | Intuitive file drop zone with 50 MB per-file limit for browser memory safety |
| **Unique Share Links** | Each session generates a Room ID and cryptographic key, embedded in the invite URL |
| **WebRTC Data Channels** | Files transfer directly between browsers — the server only helps with the initial connection handshake |
| **AES-GCM Encryption** | Every file chunk is encrypted in-browser before transmission; the key never touches the server |
| **SHA-256 Integrity Check** | Full-file hash verification on both ends guarantees zero data corruption |
| **Real-time Progress** | Live transfer percentage, speed (MB/s), and connection status indicators |
| **Auto-Download** | Completed files are automatically saved to the receiver's machine via a staggered download queue |
| **Graceful Disconnect** | If either user closes their tab, the other is notified cleanly without the app freezing |
| **Multi-File Sessions** | Sender stays connected and can keep dropping files without re-creating a room |

---

## ✦ How It Works (Architecture)

```
┌──────────┐                    ┌──────────────┐                    ┌──────────┐
│  Sender  │◄──── Socket.io ───►│  Signaling   │◄──── Socket.io ───►│ Receiver │
│ (Browser)│     offer/answer   │   Server     │     offer/answer   │ (Browser)│
└────┬─────┘     ICE candidates └──────────────┘     ICE candidates └────┬─────┘
     │                                                                    │
     │              ┌─────────────────────────────────┐                   │
     └──────────────┤  Direct WebRTC Data Channel     ├───────────────────┘
                    │  (AES-GCM encrypted chunks)     │
                    └─────────────────────────────────┘
```

1. **Sender** creates a room → server generates a unique Room ID
2. **Sender** generates an AES-GCM key locally → embeds it in the share link's URL fragment (`#key=...`)
3. **Receiver** opens the link → key is extracted from the fragment (never sent to server)
4. **Socket.io** relays WebRTC signaling (SDP offers/answers and ICE candidates)
5. **WebRTC DataChannel** opens a direct peer-to-peer connection
6. **Files are encrypted** chunk-by-chunk in the sender's browser, streamed over the DataChannel, and **decrypted + verified** in the receiver's browser

---

## ✦ Deployment Instructions

This application requires two separate deployments: one for the backend signaling server and one for the frontend React app.

### Part 1: Backend Deployment (Render)
1. Push your code to a public GitHub repository.
2. Go to [Render.com](https://render.com/) and sign up.
3. Click **New +** and select **Web Service**.
4. Connect your GitHub account and select your `p2pshare` repository.
5. In the settings, configure the following:
   - **Root Directory:** `server`
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `node index.js`
6. Click **Create Web Service**.
7. Once deployed, copy the generated URL (e.g., `https://p2pshare-backend.onrender.com`).

### Part 2: Frontend Deployment (Vercel)
1. Go to [Vercel.com](https://vercel.com/) and sign up.
2. Click **Add New...** -> **Project**.
3. Import your `p2pshare` GitHub repository.
4. In the configuration step:
   - **Root Directory:** Edit this and select `client`.
   - **Framework Preset:** Vite
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
5. **Environment Variables:** Add a new variable:
   - Name: `VITE_SERVER_URL`
   - Value: Paste the URL from Render (e.g., `https://p2pshare-backend.onrender.com`)
6. Click **Deploy**.



## ✦ Demo Video (~3 Minutes)

The demo video covers:
1. Creating a sender profile and initiating a share room
2. Sharing the encrypted link with a receiver
3. Live file transfer showing real-time progress and speed
4. SHA-256 hash verification on the receiver side
5. Auto-download of received files
6. Multi-file session (sending additional files without reconnecting)
7. Graceful disconnect handling

---

## ✦ License

This project was built for the MARS OpenProjects 2026 submission.
