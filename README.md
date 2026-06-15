# SecureDrop — Zero-Knowledge P2P File Transfer

> **MARS OpenProjects 2026** — Peer-to-Peer Encrypted File Sharing Application

## 🔗 Official Links

| Resource | Link |
|---|---|
| **Live Web App** | [https://p2-p-share-direct-file-transfer.vercel.app/](https://p2-p-share-direct-file-transfer.vercel.app/) |
| **Backend API** | [https://p2p-share-direct-file-transfer.onrender.com](https://p2p-share-direct-file-transfer.onrender.com) |
| **Demo Video** | *[Insert YouTube / Google Drive link here later]* |

---

## ✦ Project Description

SecureDrop is a browser-based file transfer tool that lets two users share files directly — peer-to-peer — without uploading anything to a server. Files are encrypted end-to-end using AES-GCM (256-bit) through the Web Crypto API, and the encryption key is embedded purely in the URL fragment (`#key=...`), meaning the signaling server never has access to the raw data or the decryption key.

**Technology Stack:**
- **Frontend:** React.js (Vite), Vanilla CSS, deployed on Vercel
- **Backend:** Node.js, Express.js, Socket.io, deployed on Render
- **P2P:** Native WebRTC API (RTCPeerConnection + RTCDataChannel)

---

## ✦ Setup Instructions

### Prerequisites
- [Node.js](https://nodejs.org/) v16 or later

### 1. Clone the Repository
```bash
git clone https://github.com/vvakki-iitr/P2P-share--Direct-File-Transfer-.git
cd P2P-share--Direct-File-Transfer-
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

## ✦ Deployment Links & Instructions

This application is deployed using two separate services:

### 1. Backend (Render)
The signaling server is hosted on Render.
- **Root Directory:** `server`
- **Build Command:** `npm install`
- **Start Command:** `node index.js`
- **URL:** [https://p2p-share-direct-file-transfer.onrender.com](https://p2p-share-direct-file-transfer.onrender.com)

### 2. Frontend (Vercel)
The React application is hosted on Vercel.
- **Root Directory:** `client`
- **Build Command:** `npm run build`
- **Environment Variables:** `VITE_SERVER_URL=https://p2p-share-direct-file-transfer.onrender.com`
- **URL:** [https://p2-p-share-direct-file-transfer.vercel.app/](https://p2-p-share-direct-file-transfer.vercel.app/)

---

## ✦ License

This project was built for the MARS OpenProjects 2026 submission.
