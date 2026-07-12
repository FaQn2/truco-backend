// ============================================================
// Nombre: server.js
// Rol: Punto de entrada del backend — levanta el servidor WebSocket.
// Fase 2, Etapa 1: corre en localhost. El puerto es configurable vía
// la variable de entorno PORT (default 3000).
// ============================================================

const { WebSocketServer } = require('ws');
const { RoomManager } = require('./src/socket-handlers/room-manager');
const { manejarConexion } = require('./src/socket-handlers/connection-handler');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

const roomManager = new RoomManager();
const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws) => {
  manejarConexion(roomManager, ws);
});

wss.on('listening', () => {
  console.log(`[server] Truco Argentino backend escuchando en ws://localhost:${PORT}`);
});

wss.on('error', (err) => {
  console.error('[server] Error del WebSocketServer:', err);
});
