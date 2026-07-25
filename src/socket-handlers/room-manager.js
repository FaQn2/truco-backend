// ============================================================
// Nombre: room-manager.js
// Rol: Sistema de salas — buscar/crear salas de distintos modos (1v1, 2v2,
//      a futuro 3v3), elegir asiento a mano (en vez de auto-asignado), y
//      reenviar los eventos del motor de juego a cada socket FILTRANDO lo
//      que cada jugador puede ver (nunca la mano del rival).
//
//      Un socket puede "ver" una sala (para el panel de detalle en vivo,
//      sin estar sentado) o estar "sentado" en un asiento — sentarse
//      implica automáticamente ver. Solo se puede ver/estar sentado en UNA
//      sala a la vez: mirar el detalle de otra sala te saca de la anterior
//      (ver salirSala).
// ============================================================

const { Partida, JUGADOR1, JUGADOR2 } = require('../game-logic/partida');

// Sin 0/O/1/I/L para evitar confusión al dictar el código en voz alta.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
const PUNTOS_OBJETIVO_DEFAULT = 30;

// Cantidad de asientos por modo. El motor de juego (partida.js) hoy solo
// sabe jugar 1v1 (2 asientos) — los demás modos quedan en estado 'completa'
// esperando a que exista un motor para esa cantidad de jugadores.
const CAPACIDAD_POR_MODO = { '1v1': 2, '2v2': 4 };

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
  constructor(code, { nombreSala, modo, puntosObjetivo = PUNTOS_OBJETIVO_DEFAULT }) {
    this.code = code;
    this.nombreSala = nombreSala || `Mesa ${code}`;
    this.modo = modo;
    this.capacidad = CAPACIDAD_POR_MODO[modo];
    this.puntosObjetivo = puntosObjetivo;
    this.estado = 'esperando'; // 'esperando' | 'completa' | 'jugando'
    // índice de asiento (0..capacidad-1) -> { ws, nombre } | null
    this.asientos = new Array(this.capacidad).fill(null);
    // Sockets mirando el panel de detalle de esta sala (incluye a los
    // sentados) — reciben DETALLE_SALA cada vez que cambia algo.
    this.viewers = new Set();
    this.partida = null;
  }

  ocupados() {
    return this.asientos.filter(Boolean).length;
  }

  estaLlena() {
    return this.ocupados() >= this.capacidad;
  }

  asientoDe(ws) {
    return this.asientos.findIndex((a) => a && a.ws === ws);
  }

  agregarViewer(ws) {
    this.viewers.add(ws);
    ws.roomCode = this.code;
  }

  elegirAsiento(ws, index, nombre) {
    if (this.estado !== 'esperando') {
      return { ok: false, error: 'La sala ya no admite más jugadores.' };
    }
    if (!Number.isInteger(index) || index < 0 || index >= this.capacidad) {
      return { ok: false, error: 'Asiento inválido.' };
    }
    if (this.asientos[index]) {
      return { ok: false, error: 'Ese asiento ya está ocupado.' };
    }

    // Si ya estaba sentado en otro asiento de esta misma sala, lo libera.
    const anterior = this.asientoDe(ws);
    if (anterior !== -1) this.asientos[anterior] = null;

    this.asientos[index] = { ws, nombre: nombre || `Jugador${index + 1}` };
    ws.seat = index;
    this.agregarViewer(ws);

    if (this.estaLlena()) {
      this.estado = this.modo === '1v1' ? 'jugando' : 'completa';
    }
    return { ok: true };
  }

  dejarAsiento(ws) {
    const index = this.asientoDe(ws);
    if (index === -1) return;
    this.asientos[index] = null;
    if (this.estado === 'completa') this.estado = 'esperando';
  }

  // Socket se va de la sala del todo: libera su asiento (si tenía) y deja de
  // verla. Si había una partida en curso, se destruye (sin reconexión en
  // esta etapa). No decide si borrar la Room del mapa — eso es del RoomManager.
  jugadorDesconectado(ws) {
    const index = this.asientoDe(ws);
    if (index !== -1) {
      this.asientos[index] = null;
      if (this.estado === 'completa') this.estado = 'esperando';
    }
    this.viewers.delete(ws);
    if (this.partida) this.partida.destruir();
  }

  wsDe(index) {
    return this.asientos[index]?.ws;
  }

  broadcast(mensaje) {
    for (const slot of this.asientos) {
      if (slot) enviar(slot.ws, mensaje);
    }
  }

  broadcastLobby(mensaje) {
    for (const ws of this.viewers) enviar(ws, mensaje);
  }

  snapshot() {
    return {
      code: this.code,
      nombreSala: this.nombreSala,
      modo: this.modo,
      capacidad: this.capacidad,
      estado: this.estado,
      asientos: this.asientos.map((slot, index) => ({
        index,
        ocupado: !!slot,
        nombre: slot ? slot.nombre : null,
      })),
    };
  }

  resumen() {
    return {
      code: this.code,
      nombreSala: this.nombreSala,
      modo: this.modo,
      ocupados: this.ocupados(),
      capacidad: this.capacidad,
    };
  }

  // Arranca la partida real — solo tiene sentido en modo 1v1 (2 asientos),
  // el único que el motor de juego (partida.js) sabe jugar hoy. Conecta cada
  // evento del motor a los sockets de la sala, filtrando la información
  // privada (cada jugador recibe SOLO su mano).
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
      [JUGADOR1]: this.asientos[JUGADOR1]?.nombre,
      [JUGADOR2]: this.asientos[JUGADOR2]?.nombre,
    };
    this.broadcast({ type: 'PARTIDA_INICIADA', puntosObjetivo: this.puntosObjetivo, nombres });
    partida.iniciarPartida();
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  crearSala(ws, { nombreSala, modo, nombreJugador, puntosObjetivo }) {
    if (!CAPACIDAD_POR_MODO[modo]) {
      enviar(ws, { type: 'ERROR', message: `Modo de sala desconocido: ${modo}` });
      return null;
    }
    this.salirSala(ws);

    let code;
    do {
      code = generarCodigo();
    } while (this.rooms.has(code));

    const room = new Room(code, { nombreSala, modo, puntosObjetivo });
    this.rooms.set(code, room);
    room.elegirAsiento(ws, 0, nombreJugador);
    enviar(ws, { type: 'SALA_CREADA', code, seat: 0 });
    enviar(ws, { type: 'DETALLE_SALA', ...room.snapshot() });
    return room;
  }

  // Salas abiertas (no llenas, no en juego) — lo que ve el buscador.
  listarSalas(modo) {
    const salas = [];
    for (const room of this.rooms.values()) {
      if (room.estado === 'jugando' || room.estaLlena()) continue;
      if (modo && room.modo !== modo) continue;
      salas.push(room.resumen());
    }
    return salas;
  }

  verSala(ws, code) {
    const room = this.rooms.get((code || '').toUpperCase());
    if (!room) {
      enviar(ws, { type: 'ERROR', message: 'La sala no existe.' });
      return null;
    }
    if (ws.roomCode && ws.roomCode !== room.code) this.salirSala(ws);
    room.agregarViewer(ws);
    enviar(ws, { type: 'DETALLE_SALA', ...room.snapshot() });
    return room;
  }

  elegirAsiento(ws, code, index, nombreJugador) {
    const room = this.rooms.get((code || '').toUpperCase());
    if (!room) {
      enviar(ws, { type: 'ERROR', message: 'La sala no existe.' });
      return;
    }
    if (ws.roomCode && ws.roomCode !== room.code) this.salirSala(ws);

    const resultado = room.elegirAsiento(ws, index, nombreJugador);
    if (!resultado.ok) {
      enviar(ws, { type: 'ERROR', message: resultado.error });
      return;
    }
    enviar(ws, { type: 'ASIENTO_CONFIRMADO', code: room.code, asiento: index });
    room.broadcastLobby({ type: 'DETALLE_SALA', ...room.snapshot() });

    if (room.estado === 'jugando') {
      room.iniciarPartida();
    }
  }

  dejarAsiento(ws, code) {
    const room = this.rooms.get((code || '').toUpperCase());
    if (!room) return;
    room.dejarAsiento(ws);
    room.broadcastLobby({ type: 'DETALLE_SALA', ...room.snapshot() });
  }

  salaDe(ws) {
    if (!ws.roomCode) return null;
    return this.rooms.get(ws.roomCode) || null;
  }

  // Saca a ws de la sala que esté viendo/ocupando (si hay alguna). La usan
  // tanto el botón "Volver" (SALIR_SALA) como una desconexión real, y
  // también se llama antes de entrar a OTRA sala para no quedar "viendo" dos
  // a la vez.
  salirSala(ws) {
    const room = this.salaDe(ws);
    ws.roomCode = null;
    ws.seat = -1;
    if (!room) return;

    const estabaJugando = room.estado === 'jugando' && room.asientoDe(ws) !== -1;
    room.jugadorDesconectado(ws);

    if (estabaJugando) {
      // Sin reconexión en esta etapa: si se fue alguien de una partida ya
      // arrancada, la sala deja de servir para nada.
      this.rooms.delete(room.code);
      return;
    }

    room.broadcastLobby({ type: 'DETALLE_SALA', ...room.snapshot() });
    if (room.viewers.size === 0) {
      this.rooms.delete(room.code);
    }
  }

  desconectar(ws) {
    this.salirSala(ws);
  }
}

module.exports = { RoomManager, Room };
