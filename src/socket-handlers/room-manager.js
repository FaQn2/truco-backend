// ============================================================
// Nombre: room-manager.js
// Rol: Sistema de salas — crear/unirse con código corto, máximo 2
//      jugadores, arranca la Partida cuando la sala se completa y
//      reenvía los eventos del motor de juego a cada socket
//      FILTRANDO lo que cada jugador puede ver (nunca la mano del rival).
// ============================================================

const { Partida, JUGADOR1, JUGADOR2 } = require('../game-logic/partida');

// Sin 0/O/1/I/L para evitar confusión al dictar el código en voz alta.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
const PUNTOS_OBJETIVO_DEFAULT = 30;

function generarCodigo() {
  let codigo = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    codigo += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return codigo;
}

function enviar(ws, mensaje) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(mensaje));
  }
}

class Room {
  constructor(code, puntosObjetivo = PUNTOS_OBJETIVO_DEFAULT) {
    this.code = code;
    this.puntosObjetivo = puntosObjetivo;
    // seat (0|1) -> { ws, nombre }
    this.jugadores = {};
    this.partida = null;
  }

  estaLlena() {
    return Object.keys(this.jugadores).length >= 2;
  }

  agregarJugador(ws, nombre) {
    const seat = this.jugadores[JUGADOR1] ? JUGADOR2 : JUGADOR1;
    this.jugadores[seat] = { ws, nombre: nombre || `Jugador${seat + 1}` };
    ws.roomCode = this.code;
    ws.seat = seat;
    return seat;
  }

  otroAsiento(seat) {
    return seat === JUGADOR1 ? JUGADOR2 : JUGADOR1;
  }

  wsDe(seat) {
    return this.jugadores[seat]?.ws;
  }

  broadcast(mensaje) {
    for (const seat of Object.keys(this.jugadores)) {
      enviar(this.jugadores[seat].ws, mensaje);
    }
  }

  // Arranca la partida una vez que los dos asientos están ocupados. Conecta
  // cada evento del motor de juego (partida.js) a los sockets de la sala,
  // filtrando la información privada (cada jugador recibe SOLO su mano).
  iniciarPartida() {
    this.partida = new Partida(this.puntosObjetivo);
    const partida = this.partida;

    partida.on('manoRepartida', (manoPorAsiento) => {
      for (const seat of [JUGADOR1, JUGADOR2]) {
        enviar(this.wsDe(seat), { type: 'MANO_REPARTIDA', mano: manoPorAsiento[seat], repartidor: partida.repartidor });
      }
    });

    partida.on('turnoCambiado', (turno) => {
      this.broadcast({ type: 'TURNO_CAMBIADO', turno });
    });

    partida.on('cartaJugada', (jugador, carta) => {
      // Pública una vez jugada: ambos jugadores ya pueden verla sobre la mesa.
      this.broadcast({ type: 'CARTA_JUGADA', jugador, carta });
    });

    partida.on('rondaResuelta', (ganador, parda) => {
      this.broadcast({ type: 'RONDA_RESUELTA', ganador, parda });
    });

    partida.on('manoTerminada', (ganador) => {
      this.broadcast({ type: 'MANO_TERMINADA', ganador });
    });

    partida.on('partidaTerminada', (ganador) => {
      this.broadcast({ type: 'PARTIDA_TERMINADA', ganador });
    });

    partida.on('puntosActualizados', (puntos) => {
      this.broadcast({ type: 'PUNTOS_ACTUALIZADOS', puntosJ1: puntos[JUGADOR1], puntosJ2: puntos[JUGADOR2] });
    });

    partida.on('cantoRealizado', (tipo, jugador) => {
      this.broadcast({ type: 'CANTO_REALIZADO', tipo, jugador });
    });

    partida.on('estadoCambiado', (estado) => {
      this.broadcast({ type: 'ESTADO_CAMBIADO', estado });
    });

    partida.on('envidoTerminado', ({ puntosJ1, puntosJ2, ganador, puntosEnJuego, revelado }) => {
      // Revela solo el PUNTAJE de envido de cada uno (así se juega en la mesa
      // real cuando se "quiere"), nunca las cartas de la mano del rival.
      this.broadcast({ type: 'ENVIDO_TERMINADO', puntosJ1, puntosJ2, ganador, puntosEnJuego, revelado });
    });

    const nombres = {
      [JUGADOR1]: this.jugadores[JUGADOR1]?.nombre,
      [JUGADOR2]: this.jugadores[JUGADOR2]?.nombre,
    };
    this.broadcast({ type: 'PARTIDA_INICIADA', puntosObjetivo: this.puntosObjetivo, nombres });
    partida.iniciarPartida();
  }

  jugadorDesconectado(seat) {
    delete this.jugadores[seat];
    const otro = this.wsDe(this.otroAsiento(seat));
    if (otro) enviar(otro, { type: 'RIVAL_DESCONECTADO' });
    // En 1v1 la partida no puede seguir con un solo jugador conectado (no
    // hay reconexión en esta etapa) — cortamos cualquier timer pendiente
    // de la Partida para que no intente emitir eventos más tarde hacia
    // una sala que ya nadie escucha.
    if (this.partida) this.partida.destruir();
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  crearSala(ws, nombre, puntosObjetivo) {
    let code;
    do {
      code = generarCodigo();
    } while (this.rooms.has(code));

    const room = new Room(code, puntosObjetivo);
    this.rooms.set(code, room);
    const seat = room.agregarJugador(ws, nombre);
    enviar(ws, { type: 'SALA_CREADA', code, seat });
    return room;
  }

  unirseSala(ws, code, nombre) {
    const room = this.rooms.get((code || '').toUpperCase());
    if (!room) {
      enviar(ws, { type: 'ERROR', message: 'La sala no existe.' });
      return null;
    }
    if (room.estaLlena()) {
      enviar(ws, { type: 'ERROR', message: 'La sala ya tiene 2 jugadores.' });
      return null;
    }

    const seat = room.agregarJugador(ws, nombre);
    enviar(ws, { type: 'SALA_UNIDA', code: room.code, seat });

    const otro = room.wsDe(room.otroAsiento(seat));
    if (otro) enviar(otro, { type: 'RIVAL_CONECTADO', nombre: room.jugadores[seat].nombre });

    if (room.estaLlena()) {
      room.iniciarPartida();
    }
    return room;
  }

  salaDe(ws) {
    if (!ws.roomCode) return null;
    return this.rooms.get(ws.roomCode) || null;
  }

  desconectar(ws) {
    const room = this.salaDe(ws);
    if (!room) return;
    room.jugadorDesconectado(ws.seat);
    // No hay reconexión en esta etapa: apenas se va un jugador (esté la
    // sala completa o esperando al rival) la sala deja de servir para
    // nada, así que la sacamos del mapa de una.
    this.rooms.delete(room.code);
  }
}

module.exports = { RoomManager, Room };
