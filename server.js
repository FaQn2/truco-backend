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

// Última red de seguridad: cubre lo que corre FUERA de un handler de mensaje
// (p.ej. los setTimeout de fin de mano en partida.js / partida_equipos.js),
// que el try/catch de connection-handler.js no puede atajar porque no están
// en esa misma pila de llamadas. Sin esto, cualquier excepción no atrapada
// mata el proceso de Node y con él TODAS las salas activas de TODOS los
// jugadores (ver DEBUG-RAILWAY.md) — se loguea con el stack completo para
// poder reproducir el bug y se sigue corriendo en vez de caerse.
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException — el proceso sigue vivo, ninguna sala se cerró:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection — el proceso sigue vivo, ninguna sala se cerró:', reason);
});

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
