// ============================================================
// Nombre: partida.js
// Rol: Orquestador central de una mano/partida 1v1, servidor autoritario
// Puerto de: scripts/autoload/game_manager.gd — misma lógica, pero acá
//            los dos "asientos" (0 y 1) son dos jugadores humanos reales
//            en vez de Jugador vs IA. Emite eventos (EventEmitter) en
//            lugar de señales de Godot; room-manager.js los escucha y
//            reenvía a cada socket filtrando lo que cada jugador puede ver.
// Fuente: docs/Reglas_Truco_Argentino.md (todas las secciones)
// ============================================================

const EventEmitter = require('events');
const Mazo = require('./mazo');
const { StateMachine, Estado } = require('./state_machine');
const { calcular: calcularEnvido } = require('./calculador_envido');
const { puedeCantar, puedeSubirEnvido } = require('./validador_cantos');
const Constants = require('./constants');

const JUGADOR1 = 0;
const JUGADOR2 = 1;

// Pausa entre que termina una mano y se reparte la siguiente — le da tiempo
// a los clientes a mostrar el resultado de la mano antes de que lleguen las
// cartas nuevas (mismo valor que PAUSA_FIN_DE_MANO_SEG en game_manager.gd).
const PAUSA_FIN_DE_MANO_MS = 1400;

const ORDEN_TRUCO = ['TRUCO', 'RETRUCO', 'VALE_CUATRO'];

class Partida extends EventEmitter {
  constructor(puntosObjetivo = 30) {
    super();
    this.puntosObjetivo = puntosObjetivo;
    this.mazo = new Mazo();
    this.maquina = new StateMachine();
    this.maquina.onEstadoCambio((_de, a) => this.emit('estadoCambiado', a));

    this.puntos = { [JUGADOR1]: 0, [JUGADOR2]: 0 };

    this.mano = { [JUGADOR1]: [], [JUGADOR2]: [] };
    // Copia fija de la mano de 3 cartas tal como se repartió, para el
    // cálculo de Envido — mano[] pierde cartas a medida que se juegan, pero
    // una carta ya tirada en la ronda 1 sigue contando para el Envido.
    this.manoEnvido = { [JUGADOR1]: [], [JUGADOR2]: [] };

    this.repartidor = JUGADOR2; // rota cada mano
    this.jugadorEsMano = true;
    this.turnoActual = JUGADOR1;

    this.rondaActual = 1;
    this.resultadosRondas = []; // -1 parda, JUGADOR1 o JUGADOR2 por ronda
    this._quienIniciaRonda = JUGADOR1;
    this._cartasJugadasRonda = {};

    this.envidoResuelto = false;
    this._cantoEnvidoPendiente = '';
    this._quienCantoEnvido = -1;
    this._cadenaEnvido = [];
    this._trucoInterrumpidoPorEnvido = false;

    this.trucoNivel = 0; // 0 = sin canto, 1 = truco, 2 = retruco, 3 = vale cuatro
    this._quienCantoTruco = -1;
    // Quien "tiene el quiero" del nivel de Truco vigente — solo ese jugador
    // puede subir la apuesta más adelante, en cualquier ronda de la mano.
    this._quienPuedeSubirTruco = -1;
    // true en cuanto se responde CUALQUIER canto de Truco (Quiero/No
    // Quiero/subir) por primera vez en la mano — "el envido está primero"
    // (sección 6) solo aplica mientras el Truco original sigue sin ninguna
    // respuesta; una vez respondido (aunque sea subiendo a Retruco) esa
    // ventana ya no se reabre con las subidas siguientes.
    this._trucoYaRespondido = false;

    this._finDeManoTimeoutId = null;
  }

  rival(jugadorId) {
    return 1 - jugadorId;
  }

  rondasGanadas(jugadorId) {
    return this.resultadosRondas.filter((r) => r === jugadorId).length;
  }

  getCartaJugadaEnRonda(jugadorId) {
    return this._cartasJugadasRonda[jugadorId] || null;
  }

  // ---------------------------------------------------------
  // Ciclo de partida / mano
  // ---------------------------------------------------------

  iniciarPartida() {
    this.puntos = { [JUGADOR1]: 0, [JUGADOR2]: 0 };
    this.repartidor = JUGADOR2;
    this.emit('puntosActualizados', { ...this.puntos });
    this.iniciarMano();
  }

  iniciarMano() {
    this.rondaActual = 1;
    this.resultadosRondas = [];
    this._cartasJugadasRonda = {};
    this.envidoResuelto = false;
    this._cantoEnvidoPendiente = '';
    this._quienCantoEnvido = -1;
    this._cadenaEnvido = [];
    this._trucoInterrumpidoPorEnvido = false;
    this.trucoNivel = 0;
    this._quienCantoTruco = -1;
    this._quienPuedeSubirTruco = -1;
    this._trucoYaRespondido = false;

    this.jugadorEsMano = this.repartidor === JUGADOR2;
    this._quienIniciaRonda = this.jugadorEsMano ? JUGADOR1 : JUGADOR2;
    this.turnoActual = this._quienIniciaRonda;

    this.mazo.barajar();
    this.mano[JUGADOR1] = this.mazo.repartir(3);
    this.mano[JUGADOR2] = this.mazo.repartir(3);
    this.manoEnvido[JUGADOR1] = [...this.mano[JUGADOR1]];
    this.manoEnvido[JUGADOR2] = [...this.mano[JUGADOR2]];

    this.maquina.transicionar(Estado.ESPERANDO_JUGADA);
    // manoRepartida lleva la mano completa de cada jugador — quien reenvía
    // esto (room-manager.js) es responsable de mandarle a cada socket SOLO
    // su propia mano, nunca mano[rival].
    this.emit('manoRepartida', { [JUGADOR1]: this.mano[JUGADOR1], [JUGADOR2]: this.mano[JUGADOR2] });
    this.emit('turnoCambiado', this.turnoActual);
  }

  // ---------------------------------------------------------
  // Tirar carta / evaluar ronda
  // ---------------------------------------------------------

  jugarCarta(jugadorId, cartaId) {
    if (jugadorId !== this.turnoActual) return false;
    if (!puedeCantar('TIRAR_CARTA', this.maquina.estadoActual, true, this.rondaActual, this.envidoResuelto)) {
      return false;
    }

    const mano = this.mano[jugadorId];
    const idx = mano.findIndex((c) => c.id === cartaId);
    if (idx === -1) return false;
    const [carta] = mano.splice(idx, 1);
    this._cartasJugadasRonda[jugadorId] = carta;
    this.emit('cartaJugada', jugadorId, carta);

    if (Object.keys(this._cartasJugadasRonda).length < 2) {
      // Falta que el rival tire su carta de esta misma ronda
      this.turnoActual = this.rival(jugadorId);
      this.emit('turnoCambiado', this.turnoActual);
      return true;
    }

    this.maquina.transicionar(Estado.EVALUANDO_MESA);
    this._resolverRonda(this._cartasJugadasRonda[JUGADOR1], this._cartasJugadasRonda[JUGADOR2]);
    this._cartasJugadasRonda = {};
    return true;
  }

  // Compara jerarquías de las dos cartas jugadas en la ronda actual y avanza el flujo
  _resolverRonda(cartaJ1, cartaJ2) {
    const j1 = cartaJ1.jerarquia_truco;
    const j2 = cartaJ2.jerarquia_truco;

    let ganadorRonda = -1;
    if (j1 > j2) ganadorRonda = JUGADOR1;
    else if (j2 > j1) ganadorRonda = JUGADOR2;

    const esParda = ganadorRonda === -1;
    this.resultadosRondas.push(ganadorRonda);
    this.emit('rondaResuelta', ganadorRonda, esParda);

    // Quién arranca la siguiente ronda (sección 9 de las reglas)
    if (esParda) {
      if (this.rondaActual === 1) {
        this._quienIniciaRonda = this.jugadorEsMano ? JUGADOR1 : JUGADOR2;
      }
      // si es parda en ronda 2, _quienIniciaRonda no cambia
    } else {
      this._quienIniciaRonda = ganadorRonda;
    }

    const ganadorMano = this._chequearGanadorMano();
    if (ganadorMano !== -1) {
      this._sumarPuntos(ganadorMano, this._puntosTrucoActuales());
      this._finDeMano(ganadorMano);
      return;
    }

    if (this.rondaActual >= 3) {
      // No debería pasar (a la ronda 3 siempre hay un ganador de mano), pero
      // por seguridad terminamos la mano a favor del Mano si quedó indefinido.
      const ganadorDefault = this.jugadorEsMano ? JUGADOR1 : JUGADOR2;
      this._sumarPuntos(ganadorDefault, this._puntosTrucoActuales());
      this._finDeMano(ganadorDefault);
      return;
    }

    this.rondaActual += 1;
    this.turnoActual = this._quienIniciaRonda;
    this.maquina.transicionar(Estado.ESPERANDO_JUGADA);
    this.emit('turnoCambiado', this.turnoActual);
  }

  // Puntos que vale la mano según el nivel de Truco alcanzado (querido), o 1 si no se cantó
  _puntosTrucoActuales() {
    if (this.trucoNivel === 0) return 1;
    const cantoActual = ORDEN_TRUCO[this.trucoNivel - 1];
    return Constants.PUNTOS_TRUCO[cantoActual] || 1;
  }

  // Determina si ya hay ganador de la mano (sección 9). Devuelve JUGADOR1 /
  // JUGADOR2 si ya se decidió, o -1 si hace falta seguir jugando.
  _chequearGanadorMano() {
    const n = this.resultadosRondas.length;
    if (n < 2) return -1;

    const r1 = this.resultadosRondas[0];
    const r2 = this.resultadosRondas[1];

    if (n === 2) {
      if (r1 === -1) {
        // Parda en ronda 1: quien gane la ronda 2 gana la mano directo
        return r2 !== -1 ? r2 : -1;
      }
      if (r2 === -1) {
        // Parda en ronda 2 tras un ganador en ronda 1: la parda no le da
        // nada al rival, así que quien ganó la primera ya gana la mano acá
        // mismo — no hace falta jugar la ronda 3.
        return r1;
      }
      if (r1 === r2) return r1;
      return -1; // 1 a 1: se define en ronda 3
    }

    // n === 3
    const r3 = this.resultadosRondas[2];
    if (r3 !== -1) return r3;
    // Ronda 3 también parda. Para llegar acá con r1 !== -1, ronda 1 y ronda 2
    // tuvieron que tener ganadores distintos (1 a 1: ver el "return -1" de
    // arriba — es el único camino que deja la mano sin decidir en n===2 con
    // r1 con ganador) — en ese caso gana quien ganó la PRIMERA ronda, no "el
    // Mano" (sección 9: la parda de la 3ra no le da nada al que perdió la 1ra).
    if (r1 !== -1) return r1;
    // Achica el otro caso: r1 y r2 fueron parda-parda, y ahora también la
    // ronda 3 — recién en un triple empate desempata el Mano (sección 9).
    return this.jugadorEsMano ? JUGADOR1 : JUGADOR2;
  }

  // ---------------------------------------------------------
  // Envido
  // ---------------------------------------------------------

  cantarEnvido(jugadorId, tipo) {
    const estado = this.maquina.estadoActual;
    const interrumpeTruco = estado === Estado.RESOLVIENDO_TRUCO;
    // Si se está interrumpiendo un Truco sin responder, solo puede hacerlo
    // el jugador contrario al que cantó ese Truco (sección 6).
    if (interrumpeTruco && jugadorId === this._quienCantoTruco) return false;
    // Y solo mientras ESE Truco original siga sin ninguna respuesta — si ya
    // se respondió (aunque haya sido subiendo a Retruco/Vale Cuatro en vez
    // de interrumpir con Envido), la ventana ya se cerró para toda la mano
    // (bug reportado y corregido en el cliente Godot 2026-08-10, mismo hueco acá).
    if (interrumpeTruco && this._trucoYaRespondido) return false;
    // Sección 6: el Envido se cierra en cuanto YO ya puse mi carta sobre la
    // mesa esta ronda, aunque el Truco recién cantado por el rival siga sin
    // responder y en teoría "me toque a mí" contestarlo — ya usé mi
    // oportunidad de cantar Envido en el momento en que elegí tirar la
    // carta en vez de cantar (bug encontrado y corregido en el cliente
    // Godot 2026-08-05, mismo hueco acá).
    if (interrumpeTruco && this._cartasJugadasRonda[jugadorId]) return false;
    // Fuera de una interrupción, solo puede abrir el Envido quien tiene el
    // turno (docs/Reglas_Truco_Argentino.md sección 6: "el jugador solo
    // puede cantar cuando es su turno de tirar o cantar").
    if (!interrumpeTruco && jugadorId !== this.turnoActual) return false;
    if (!puedeCantar(tipo, estado, true, this.rondaActual, this.envidoResuelto)) return false;

    this._trucoInterrumpidoPorEnvido = interrumpeTruco;
    this._cadenaEnvido = [tipo];
    this._cantoEnvidoPendiente = tipo;
    this._quienCantoEnvido = jugadorId;
    this.emit('cantoRealizado', tipo, jugadorId);
    this.maquina.transicionar(Estado.RESOLVIENDO_ENVIDO);
    return true;
  }

  puedeEscalarEnvido(tipo) {
    return this.maquina.estadoActual === Estado.RESOLVIENDO_ENVIDO && puedeSubirEnvido(this._cadenaEnvido, tipo);
  }

  escalarEnvido(jugadorId, tipo) {
    if (this.maquina.estadoActual !== Estado.RESOLVIENDO_ENVIDO) return false;
    if (jugadorId === this._quienCantoEnvido) return false;
    if (!puedeSubirEnvido(this._cadenaEnvido, tipo)) return false;

    this._cadenaEnvido.push(tipo);
    this._cantoEnvidoPendiente = tipo;
    this._quienCantoEnvido = jugadorId;
    this.emit('cantoRealizado', tipo, jugadorId);
    // El estado sigue siendo RESOLVIENDO_ENVIDO, pero hay que reemitir la
    // transición: es la única forma en que el rival se entera de que ahora
    // le toca responder a ESTA subida.
    this.maquina.transicionar(Estado.RESOLVIENDO_ENVIDO);
    return true;
  }

  responderEnvido(jugadorId, quiero) {
    const accion = quiero ? 'QUIERO' : 'NO_QUIERO';
    if (
      !puedeCantar(
        accion,
        this.maquina.estadoActual,
        jugadorId === this._quienCantoEnvido,
        this.rondaActual,
        this.envidoResuelto
      )
    ) {
      return false;
    }

    this.envidoResuelto = true;
    this.emit('cantoRealizado', accion, jugadorId);

    const ptsJ1 = calcularEnvido(this.manoEnvido[JUGADOR1]);
    const ptsJ2 = calcularEnvido(this.manoEnvido[JUGADOR2]);
    let ganadorEnvido;

    if (quiero) {
      let ganador;
      if (ptsJ1 === ptsJ2) {
        // Empate: convención estándar del Truco — gana el Mano.
        ganador = this.jugadorEsMano ? JUGADOR1 : JUGADOR2;
      } else {
        ganador = ptsJ1 > ptsJ2 ? JUGADOR1 : JUGADOR2;
      }

      const ultimoCanto = this._cadenaEnvido[this._cadenaEnvido.length - 1];
      let puntos;
      if (ultimoCanto === 'FALTA_ENVIDO') {
        // Falta Envido no se suma a la cadena: reemplaza todo (sección 6).
        const ptsLider = Math.max(this.puntos[JUGADOR1], this.puntos[JUGADOR2]);
        puntos = Constants.calcularFaltaEnvido(this.puntosObjetivo, ptsLider);
      } else {
        puntos = this._cadenaEnvido.reduce((acc, canto) => acc + (Constants.PUNTOS_ENVIDO[canto] || 0), 0);
      }
      this._sumarPuntos(ganador, puntos);
      this.emit('envidoTerminado', { puntosJ1: ptsJ1, puntosJ2: ptsJ2, ganador, puntosEnJuego: puntos, revelado: true });
      ganadorEnvido = ganador;
    } else {
      // No querido: 1 punto por cada canto de la cadena (sección 6 y 11),
      // se lo lleva quien hizo el último canto (el que quedó sin responder).
      const puntosNoQuerido = this._cadenaEnvido.length;
      this._sumarPuntos(this._quienCantoEnvido, puntosNoQuerido);
      this.emit('envidoTerminado', {
        puntosJ1: ptsJ1,
        puntosJ2: ptsJ2,
        ganador: this._quienCantoEnvido,
        puntosEnJuego: puntosNoQuerido,
        revelado: false,
      });
      ganadorEnvido = this._quienCantoEnvido;
    }

    this._cantoEnvidoPendiente = '';
    this._quienCantoEnvido = -1;
    this._cadenaEnvido = [];

    // Si el Envido ya alcanzó el puntaje objetivo (p.ej. Falta Envido: sección
    // 6, "gana la partida automáticamente"), la partida termina ACÁ.
    if (this.puntos[JUGADOR1] >= this.puntosObjetivo || this.puntos[JUGADOR2] >= this.puntosObjetivo) {
      this._trucoInterrumpidoPorEnvido = false;
      this._finDeMano(ganadorEnvido);
      return true;
    }

    if (this._trucoInterrumpidoPorEnvido) {
      this._trucoInterrumpidoPorEnvido = false;
      this.maquina.transicionar(Estado.RESOLVIENDO_TRUCO);
    } else {
      this.maquina.transicionar(Estado.ESPERANDO_JUGADA);
    }
    return true;
  }

  // ---------------------------------------------------------
  // Truco
  // ---------------------------------------------------------

  cantarTruco(jugadorId) {
    if (this.trucoNivel !== 0) {
      // Ya se cantó Truco en esta mano — de acá en más solo se puede subir
      // (Retruco/Vale Cuatro vía subirTruco), no "cantar Truco" de nuevo.
      return false;
    }
    // Solo puede abrir el Truco quien tiene el turno (misma regla que el
    // Envido — sección 8: "el jugador solo puede cantar cuando es su turno").
    if (jugadorId !== this.turnoActual) return false;
    if (!puedeCantar('TRUCO', this.maquina.estadoActual, true, this.rondaActual, this.envidoResuelto)) return false;

    this.trucoNivel = 1;
    this._quienCantoTruco = jugadorId;
    this._quienPuedeSubirTruco = -1; // queda pendiente hasta que el rival responda
    this.emit('cantoRealizado', 'TRUCO', jugadorId);
    this.maquina.transicionar(Estado.RESOLVIENDO_TRUCO);
    return true;
  }

  // ¿jugadorId puede subir la apuesta AHORA MISMO, jugando con normalidad
  // (sin que haya un canto pendiente de responder)? Solo puede subir quien
  // tiene el "quiero" vigente, en cualquier ronda (sección 8).
  puedeSubirTruco(jugadorId) {
    return (
      this.maquina.estadoActual === Estado.ESPERANDO_JUGADA &&
      this.trucoNivel > 0 &&
      this.trucoNivel < ORDEN_TRUCO.length &&
      jugadorId === this._quienPuedeSubirTruco
    );
  }

  subirTruco(jugadorId) {
    if (!this.puedeSubirTruco(jugadorId)) return false;
    this.trucoNivel += 1;
    this._quienCantoTruco = jugadorId;
    this._quienPuedeSubirTruco = -1; // vuelve a quedar pendiente de que el rival responda
    this.emit('cantoRealizado', ORDEN_TRUCO[this.trucoNivel - 1], jugadorId);
    this.maquina.transicionar(Estado.RESOLVIENDO_TRUCO);
    return true;
  }

  responderTruco(jugadorId, quiero, subir = false) {
    if (
      !puedeCantar(
        quiero ? 'QUIERO' : 'NO_QUIERO',
        this.maquina.estadoActual,
        jugadorId === this._quienCantoTruco,
        this.rondaActual,
        this.envidoResuelto
      )
    ) {
      return false;
    }
    this._trucoYaRespondido = true;

    if (!quiero) {
      this.emit('cantoRealizado', 'NO_QUIERO', jugadorId);
      const cantoActual = ORDEN_TRUCO[this.trucoNivel - 1];
      const puntosNoQuerido = Constants.PUNTOS_NO_QUERIDO_TRUCO[cantoActual] || 1;
      this._sumarPuntos(this._quienCantoTruco, puntosNoQuerido);
      this._finDeMano(this._quienCantoTruco);
      return true;
    }

    if (subir && this.trucoNivel < ORDEN_TRUCO.length) {
      this.trucoNivel += 1;
      this._quienCantoTruco = jugadorId;
      this._quienPuedeSubirTruco = -1; // queda pendiente de que el rival responda a ESTA subida
      this.emit('cantoRealizado', ORDEN_TRUCO[this.trucoNivel - 1], jugadorId);
      // Sigue en RESOLVIENDO_TRUCO a la espera de la respuesta del otro
      // jugador. Reemitimos la transición para que el rival se entere de
      // que la respuesta pendiente ahora es de ESTA subida.
      this.maquina.transicionar(Estado.RESOLVIENDO_TRUCO);
      return true;
    }

    // Quiero "plano" (sin subir ahora): jugadorId se queda con el "quiero"
    // de este nivel y puede subirlo más adelante, en cualquier ronda de
    // esta mano (sección 8) — ver subirTruco().
    this._quienPuedeSubirTruco = jugadorId;
    this.emit('cantoRealizado', 'QUIERO', jugadorId);
    this.maquina.transicionar(Estado.ESPERANDO_JUGADA);
    return true;
  }

  // ---------------------------------------------------------
  // Irse al mazo
  // ---------------------------------------------------------

  irseAlMazo(jugadorId) {
    // Además de tirar carta en tu turno, también sirve para rendirse directo
    // en vez de responder Quiero/No Quiero a un Envido o Truco que cantó el
    // rival (sección 10: "en cualquier momento de cualquier ronda").
    const estado = this.maquina.estadoActual;
    let jugadorEsElQueCanto = false;
    if (estado === Estado.RESOLVIENDO_ENVIDO) {
      jugadorEsElQueCanto = jugadorId === this._quienCantoEnvido;
    } else if (estado === Estado.RESOLVIENDO_TRUCO) {
      jugadorEsElQueCanto = jugadorId === this._quienCantoTruco;
    } else if (jugadorId !== this.turnoActual) {
      return false;
    }
    if (!puedeCantar('IR_AL_MAZO', estado, jugadorEsElQueCanto, this.rondaActual, this.envidoResuelto)) {
      return false;
    }
    this.emit('cantoRealizado', 'ME_VOY_AL_MAZO', jugadorId);
    const rival = this.rival(jugadorId);
    this._sumarPuntos(rival, this._puntosIrseAlMazo(estado));
    this._finDeMano(rival);
    return true;
  }

  // Cuántos puntos se lleva el rival si jugadorId se va al mazo AHORA MISMO
  // (sección 10): con un Envido/Truco cantado y sin responder, el mismo
  // costo que decir "No Quiero"; si no hay nada pendiente, el valor del
  // Truco ya confirmado (o 1 si todavía no se cantó nada).
  _puntosIrseAlMazo(estado) {
    if (estado === Estado.RESOLVIENDO_ENVIDO) {
      return this._cadenaEnvido.length;
    }
    if (estado === Estado.RESOLVIENDO_TRUCO) {
      const cantoActual = ORDEN_TRUCO[this.trucoNivel - 1];
      return Constants.PUNTOS_NO_QUERIDO_TRUCO[cantoActual] || 1;
    }
    if (this.trucoNivel > 0) {
      const cantoActual = ORDEN_TRUCO[this.trucoNivel - 1];
      return Constants.PUNTOS_TRUCO[cantoActual] || 1;
    }
    return 1;
  }

  // ---------------------------------------------------------
  // Puntos / fin de mano / fin de partida
  // ---------------------------------------------------------

  // Ojo: se topea acá en vez de en _finDeMano, porque puntos ya puede pasarse
  // del objetivo en una sola suma (ej. Falta Envido, o Vale Cuatro con la
  // mano ya cerca de los puntosObjetivo) — sin el tope, un final normal a 30
  // podía terminar mostrando 32.
  _sumarPuntos(ganador, puntos) {
    this.puntos[ganador] = Math.min(this.puntos[ganador] + puntos, this.puntosObjetivo);
    this.emit('puntosActualizados', { ...this.puntos });
  }

  _finDeMano(ganadorMano) {
    // Los puntos ya se sumaron en el llamador (cada camino de fin de mano
    // tiene su propia regla: no querido, irse al mazo, o valor del truco actual)
    this.maquina.transicionar(Estado.FIN_DE_MANO);
    this.emit('manoTerminada', ganadorMano);

    this._finDeManoTimeoutId = setTimeout(() => {
      this._finDeManoTimeoutId = null;
      if (this.puntos[JUGADOR1] >= this.puntosObjetivo || this.puntos[JUGADOR2] >= this.puntosObjetivo) {
        const ganadorPartida = this.puntos[JUGADOR1] >= this.puntosObjetivo ? JUGADOR1 : JUGADOR2;
        this.maquina.transicionar(Estado.FIN_PARTIDA);
        this.emit('partidaTerminada', ganadorPartida);
      } else {
        this.repartidor = this.rival(this.repartidor);
        this.iniciarMano();
      }
    }, PAUSA_FIN_DE_MANO_MS);
  }

  // Corta cualquier timer pendiente (el reparto de la siguiente mano) y
  // desconecta todos los listeners. Hay que llamarlo cuando la sala se
  // queda sin los dos jugadores — si no, el setTimeout de _finDeMano igual
  // dispara más tarde e intenta emitir eventos hacia una sala que ya nadie
  // escucha (room-manager.js explota tratando de mandarle un mensaje a un
  // socket que ya no existe).
  destruir() {
    if (this._finDeManoTimeoutId) {
      clearTimeout(this._finDeManoTimeoutId);
      this._finDeManoTimeoutId = null;
    }
    this.removeAllListeners();
  }
}

module.exports = { Partida, JUGADOR1, JUGADOR2 };
