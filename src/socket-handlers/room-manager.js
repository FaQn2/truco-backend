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
const { PartidaEquipos, equipoDe } = require('../game-logic/partida_equipos');

// Sin 0/O/1/I/L para evitar confusión al dictar el código en voz alta.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
const PUNTOS_OBJETIVO_DEFAULT = 30;
const CHAT_LARGO_MAXIMO = 200;
// "¡Revancha!" — ventana para que todos los sentados confirmen que quieren
// otra partida antes de que el server dé la sala por perdida y mande a
// todos de vuelta al lobby (ver Room.iniciarRevancha).
const REVANCHA_PLAZO_SEGUNDOS = 30;

// Cantidad de asientos por modo.
const CAPACIDAD_POR_MODO = { '1v1': 2, '2v2': 4 };

// Modos que arrancan la partida SOLOS al llenarse la mesa (pasan a estado
// 'jugando' e iniciarPartida() se dispara enseguida). El motor de 2v2
// (partida_equipos.js) ya existe y está probado con test-client-2v2.js,
// pero el cliente Godot todavía no tiene la escena 3D de 4 asientos —
// arrancarla en producción mandaría PARTIDA_INICIADA a jugadores que caen
// en una pantalla que no sabe renderizar un 2v2. HABILITAR_2V2=1 lo
// prende igual (para poder seguir corriendo test-client-2v2.js en local
// contra el protocolo real) — Railway no define esa variable, así que en
// producción 2v2 queda en 'completa' hasta sacarlo de acá.
const MODOS_QUE_ARRANCAN_SOLOS = new Set(
  process.env.HABILITAR_2V2 === '1' ? ['1v1', '2v2'] : ['1v1']
);

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
    // true apenas el motor emite 'partidaTerminada' (ver _iniciarPartida1v1 /
    // _iniciarPartidaEquipos) — `estado` se queda en 'jugando' incluso
    // después de que la partida terminó (nadie lo cambia), así que sin esta
    // bandera una desconexión que llega justo después de un final legítimo
    // (p.ej. el ganador cierra el cliente al instante de ganar) se leía como
    // abandono en salirSala() y mandaba un SEGUNDO PARTIDA_TERMINADA
    // contradictorio (declarando ganador al equipo/jugador que ya había
    // perdido, porque _declararGanadorPorAbandono invierte el resultado en
    // base a quién se fue).
    this.partidaTerminada = false;

    // Ventana de "¡Revancha!" activa (null si no hay ninguna en curso) — ver
    // iniciarRevancha/confirmarRevancha/_revanchaVencida. Solo existe entre
    // un final de partida NORMAL (nunca tras un abandono: ahí la sala ya se
    // borra sola, ver RoomManager.salirSala) y que se resuelva (todos
    // confirman, se acaba el tiempo, o alguien se desconecta).
    this.revancha = null;
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
      this.estado = MODOS_QUE_ARRANCAN_SOLOS.has(this.modo) ? 'jugando' : 'completa';
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

  // Arranca la partida real — elige el motor según la capacidad de la sala.
  // Conecta cada evento del motor a los sockets de la sala, filtrando la
  // información privada (cada jugador recibe SOLO su mano, y en 2v2 también
  // la de su compañero — nunca las del equipo rival). También la usa la
  // revancha para arrancar una partida nueva en la misma sala — por eso
  // primero destruye cualquier `partida` vieja que haya quedado colgada
  // (normalmente no la hay: ver el comentario en `partidaTerminada`).
  iniciarPartida() {
    if (this.partida) this.partida.destruir();
    if (this.capacidad === 4) {
      this._iniciarPartidaEquipos();
    } else {
      this._iniciarPartida1v1();
    }
  }

  // ---------------------------------------------------------
  // "¡Revancha!" — ver comentario de this.revancha en el constructor.
  // ---------------------------------------------------------

  iniciarRevancha() {
    if (this.revancha) clearTimeout(this.revancha.timeoutId);
    this.revancha = {
      confirmados: new Set(),
      timeoutId: setTimeout(() => this._revanchaVencida(), REVANCHA_PLAZO_SEGUNDOS * 1000),
    };
    this.broadcast({ type: 'REVANCHA_DISPONIBLE', plazoSegundos: REVANCHA_PLAZO_SEGUNDOS });
  }

  // Devuelve false si no hay ninguna revancha en curso para este asiento
  // (ya venció, ya se confirmó entera, o ws no está sentado acá) — el
  // llamador (RoomManager.confirmarRevancha) le manda un ERROR al cliente
  // en ese caso.
  confirmarRevancha(ws) {
    if (!this.revancha) return false;
    const seat = this.asientoDe(ws);
    if (seat === -1) return false;

    this.revancha.confirmados.add(seat);
    this.broadcast({ type: 'REVANCHA_ESTADO', confirmados: [...this.revancha.confirmados] });

    if (this.revancha.confirmados.size >= this.capacidad) {
      clearTimeout(this.revancha.timeoutId);
      this.revancha = null;
      // La partida terminó de forma normal para llegar hasta acá (una
      // revancha nunca arranca tras un abandono), así que hay que volver a
      // habilitar tanto partidaTerminada como el chequeo de abandono en
      // salirSala() para la partida NUEVA que arranca ahora.
      this.partidaTerminada = false;
      this.iniciarPartida();
    }
    return true;
  }

  _revanchaVencida() {
    if (!this.revancha) return;
    this.revancha = null;
    this.broadcast({ type: 'REVANCHA_CANCELADA', motivo: 'tiempo' });
  }

  // Alguien se desconectó mientras la ventana de revancha seguía abierta:
  // no tiene sentido seguir esperando a los demás — se cancela para todos
  // (RoomManager.salirSala es quien borra la Room del mapa después de esto).
  cancelarRevanchaPorDesconexion(asientoQueSeFue) {
    if (!this.revancha) return;
    clearTimeout(this.revancha.timeoutId);
    this.revancha = null;
    this.broadcast({ type: 'REVANCHA_CANCELADA', motivo: 'desconexion', asiento: asientoQueSeFue });
  }

  _iniciarPartida1v1() {
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
      this.partidaTerminada = true;
      this.broadcast({ type: 'PARTIDA_TERMINADA', ganador });
      this.iniciarRevancha();
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
    this.broadcast({ type: 'PARTIDA_INICIADA', modo: this.modo, puntosObjetivo: this.puntosObjetivo, nombres });
    partida.iniciarPartida();
  }

  // Equivalente 2v2 de _iniciarPartida1v1 — mismos nombres de mensaje donde
  // el significado es el mismo (TURNO_CAMBIADO, CARTA_JUGADA,
  // ESTADO_CAMBIADO, CANTO_REALIZADO); donde cambia de forma lleva campos
  // nuevos (manoCompanero, ganadorEquipo, puntosEquipoA/B) o mensajes nuevos
  // (la fase de declaración de envido en cadena, sección 17).
  _iniciarPartidaEquipos() {
    this.partida = new PartidaEquipos(this.puntosObjetivo);
    const partida = this.partida;
    const companeroDe = (asiento) => partida.companeroDe(asiento);

    partida.on('manoRepartida', (manoPorAsiento) => {
      for (let asiento = 0; asiento < 4; asiento++) {
        enviar(this.wsDe(asiento), {
          type: 'MANO_REPARTIDA',
          mano: manoPorAsiento[asiento],
          manoCompanero: manoPorAsiento[companeroDe(asiento)],
          repartidor: partida.repartidor,
        });
      }
    });

    partida.on('turnoCambiado', (turno) => {
      this.broadcast({ type: 'TURNO_CAMBIADO', turno });
    });

    partida.on('cartaJugada', (jugador, carta) => {
      this.broadcast({ type: 'CARTA_JUGADA', jugador, carta });
    });

    partida.on('rondaResuelta', (ganadorEquipo, parda) => {
      this.broadcast({ type: 'RONDA_RESUELTA', ganadorEquipo, parda });
    });

    partida.on('manoTerminada', (ganadorEquipo) => {
      this.broadcast({ type: 'MANO_TERMINADA', ganadorEquipo });
    });

    partida.on('partidaTerminada', (ganadorEquipo) => {
      this.partidaTerminada = true;
      this.broadcast({ type: 'PARTIDA_TERMINADA', ganadorEquipo });
      this.iniciarRevancha();
    });

    partida.on('puntosActualizados', (puntos) => {
      this.broadcast({ type: 'PUNTOS_ACTUALIZADOS', puntosEquipoA: puntos[0], puntosEquipoB: puntos[1] });
    });

    partida.on('cantoRealizado', (tipo, jugador) => {
      this.broadcast({ type: 'CANTO_REALIZADO', tipo, jugador });
    });

    partida.on('estadoCambiado', (estado) => {
      this.broadcast({ type: 'ESTADO_CAMBIADO', estado });
    });

    // Fase de declaración de envido en cadena (sección 17) — no existe en 1v1.
    partida.on('envidoDeclaracionTurno', (asiento) => {
      this.broadcast({ type: 'ENVIDO_DECLARACION_TURNO', asiento });
    });

    partida.on('envidoDeclarado', (asiento, valor) => {
      this.broadcast({ type: 'ENVIDO_DECLARADO', asiento, valor });
    });

    partida.on('envidoTerminado', ({ declaraciones, ganadorEquipo, puntosEnJuego, revelado }) => {
      this.broadcast({ type: 'ENVIDO_TERMINADO', declaraciones, ganadorEquipo, puntosEnJuego, revelado });
    });

    const nombres = {};
    for (let asiento = 0; asiento < 4; asiento++) {
      nombres[asiento] = this.asientos[asiento]?.nombre;
    }
    this.broadcast({ type: 'PARTIDA_INICIADA', modo: this.modo, puntosObjetivo: this.puntosObjetivo, nombres });
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

  // Reenvía hacia dónde gira la cabeza de ws al resto de la sala (1v1 y
  // 2v2). Es puramente cosmético — no pasa por Partida/PartidaEquipos ni
  // valida turno, así que puede mandarse en cualquier momento (incluso en
  // el lobby, aunque ahí no hay nadie del otro lado escuchando todavía). El
  // asiento SIEMPRE es ws.seat (nunca lo que mande el cliente), mismo
  // criterio que el resto de las acciones — ver manejarAccionDeJuego.
  mirar(ws, yaw, pitch) {
    const room = this.salaDe(ws);
    if (!room || ws.seat === undefined || ws.seat < 0) return;
    const yawSeguro = Math.max(-90, Math.min(90, Number(yaw) || 0));
    const pitchSeguro = Math.max(-90, Math.min(90, Number(pitch) || 0));
    room.broadcast({ type: 'MIRAR', asiento: ws.seat, yaw: yawSeguro, pitch: pitchSeguro });
  }

  // Reenvía el efecto "ojos saltones" (zoom con click derecho) de ws al
  // resto de la sala — mismo criterio que mirar(): puro relay, no pasa por
  // Partida/PartidaEquipos ni valida turno. El asiento SIEMPRE es ws.seat,
  // nunca lo que mande el cliente.
  ojos(ws, activo) {
    const room = this.salaDe(ws);
    if (!room || ws.seat === undefined || ws.seat < 0) return;
    room.broadcast({ type: 'OJOS', asiento: ws.seat, activo: Boolean(activo) });
  }

  // Reenvía una seña (gesto facial deliberado del sistema real de señas,
  // 2v2 online) de ws — A DIFERENCIA de ojos()/mirar() (que sí van a toda
  // la sala), una seña es secreta entre compañeros: en la mesa real nadie
  // le tapa la cara al rival, pero acá el "secreto" es justamente el punto
  // del sistema de señas, así que el servidor solo se la reenvía al asiento
  // de su mismo equipo (equipoDe = asiento % 2, ver partida_equipos.js),
  // nunca al equipo rival. Sigue sin pasar por Partida/PartidaEquipos ni
  // validar turno — el asiento SIEMPRE es ws.seat, nunca lo que mande el
  // cliente.
  sena(ws, tipo, activo) {
    const room = this.salaDe(ws);
    if (!room || ws.seat === undefined || ws.seat < 0) return;
    const mensaje = { type: 'SENA', asiento: ws.seat, tipo: String(tipo || ''), activo: Boolean(activo) };
    const miEquipo = equipoDe(ws.seat);
    room.asientos.forEach((slot, index) => {
      if (slot && index !== ws.seat && equipoDe(index) === miEquipo) {
        enviar(slot.ws, mensaje);
      }
    });
  }

  // Chat en vivo — mismo criterio que mirar(): puro relay entre los sentados
  // de la sala, no pasa por Partida/PartidaEquipos ni valida turno. El
  // asiento y el nombre SIEMPRE salen del propio servidor (room.asientos),
  // nunca de lo que mande el cliente, para que nadie pueda hablar
  // haciéndose pasar por otro jugador.
  chat(ws, texto) {
    const room = this.salaDe(ws);
    if (!room || ws.seat === undefined || ws.seat < 0) return;
    const limpio = String(texto || '').trim().slice(0, CHAT_LARGO_MAXIMO);
    if (!limpio) return;
    const nombre = room.asientos[ws.seat]?.nombre || `Jugador${ws.seat + 1}`;
    room.broadcast({ type: 'CHAT_MENSAJE', asiento: ws.seat, nombre, texto: limpio });
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

    // room.asientoDe(ws) hay que leerlo ANTES de jugadorDesconectado (que
    // limpia el asiento) — es lo único que nos dice quién se fue y, con eso,
    // quién ganó por abandono. El chequeo de !room.partidaTerminada evita
    // declarar un abandono (y mandar un PARTIDA_TERMINADA contradictorio) si
    // la partida ya se cerró de forma legítima un instante antes — ver el
    // comentario en el constructor de Room sobre `partidaTerminada`.
    const seatIndex = room.asientoDe(ws);
    const estabaJugando = room.estado === 'jugando' && seatIndex !== -1 && !room.partidaTerminada;
    // La partida ya terminó (room.partidaTerminada === true), pero seguía
    // abierta la ventana de "¡Revancha!" — sin este chequeo, este caso caía
    // en la rama de "estaba en el lobby" de más abajo, que solo actualiza
    // DETALLE_SALA (a nadie, porque ya nadie está mirando esa pantalla) y
    // deja a los demás esperando confirmaciones que nunca van a llegar.
    const estabaEnRevancha = seatIndex !== -1 && !!room.revancha;
    room.jugadorDesconectado(ws);

    if (estabaJugando) {
      // Sin reconexión en esta etapa: si se fue alguien de una partida ya
      // arrancada, no tiene sentido seguir — se termina ahí mismo y gana
      // el/los que quedaron.
      this._declararGanadorPorAbandono(room, seatIndex);
      this.rooms.delete(room.code);
      return;
    }

    if (estabaEnRevancha) {
      // Mismo criterio "sin reconexión": si uno se va mientras los demás
      // esperaban confirmación, no tiene sentido seguir esperando — se
      // cancela para todos y se manda a la sala de multijugador.
      room.cancelarRevanchaPorDesconexion(seatIndex);
      this.rooms.delete(room.code);
      return;
    }

    room.broadcastLobby({ type: 'DETALLE_SALA', ...room.snapshot() });
    if (room.viewers.size === 0) {
      this.rooms.delete(room.code);
    }
  }

  // PARTIDA_TERMINADA con el mismo shape que el final normal de una partida
  // (ver Room._iniciarPartida1v1 / _iniciarPartidaEquipos: "ganador" en 1v1,
  // "ganadorEquipo" en 2v2) más "abandono: true" y "asientoAbandono" (el
  // asiento que se fue), para que el cliente pueda mostrar "el rival
  // abandonó" y hacer desaparecer su personaje de la mesa en vez de un cierre
  // de mano común. Solo llega a los asientos que quedan: jugadorDesconectado
  // ya vació el del que se fue, y Room.broadcast solo manda a asientos ocupados.
  _declararGanadorPorAbandono(room, seatIndexQueSeFue) {
    if (room.capacidad === 4) {
      const ganadorEquipo = 1 - equipoDe(seatIndexQueSeFue);
      room.broadcast({ type: 'PARTIDA_TERMINADA', ganadorEquipo, abandono: true, asientoAbandono: seatIndexQueSeFue });
    } else {
      const ganador = seatIndexQueSeFue === JUGADOR1 ? JUGADOR2 : JUGADOR1;
      room.broadcast({ type: 'PARTIDA_TERMINADA', ganador, abandono: true, asientoAbandono: seatIndexQueSeFue });
    }
  }

  // "¡Revancha!" — ws confirma que quiere otra partida en la misma sala.
  // Mismo criterio de nunca confiar en el cliente que el resto de las
  // acciones: el asiento sale de ws.seat (vía Room.asientoDe), nunca de lo
  // que mande el mensaje.
  confirmarRevancha(ws) {
    const room = this.salaDe(ws);
    if (!room) {
      enviar(ws, { type: 'ERROR', message: 'No estás en ninguna sala.' });
      return;
    }
    if (!room.confirmarRevancha(ws)) {
      enviar(ws, { type: 'ERROR', message: 'No se puede confirmar la revancha ahora.' });
    }
  }

  desconectar(ws) {
    this.salirSala(ws);
  }
}

module.exports = { RoomManager, Room };
