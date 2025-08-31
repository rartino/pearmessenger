// Configuration for PeerMessenger
// If you want auto-reconnect, set SIGNALING_URL to your WebSocket endpoint (wss://...)
export const CONFIG = {
  SIGNALING_URL: 'wss://pearmessager-connect-relay.rickard-armiento.workers.dev', // e.g., "wss://your-worker.example/ws"
  RECONNECT_MIN_MS: 1500,
  RECONNECT_MAX_MS: 15000
};
