// ============================================================
// Nombre: partida_equipos.js
// Rol: Orquestador de una mano/partida 2v2 (equipos de 2), servidor
//      autoritario — hermano de partida.js (que sigue manejando 1v1 sin
//      cambios), pero para 4 asientos divididos en 2 equipos.
// Fuente: docs/Reglas_Truco_Argentino.md sección 17 (extiende las
//         secciones 5, 6, 8, 9, 10 y 12 para el caso de 4 jugadores).
// ============================================================

const EventEmitter = require('events');
const Mazo = require('./mazo');
const { StateMachine, Estado } = require('./state_machine');
const { calcular: calcularEnvido } = require('./calculador_envido');
const { puedeCantar, puedeSubirEnvido } = require('./validador_cantos');
const Constants = require('./constants');

const NUM_ASIENTOS = 4;
const ORDEN_TRUCO = ['TRUCO', 'RETRUCO', 'VALE_CUATRO'];

// Pausa entre que termina una mano y se reparte la siguiente — mismo valor
// que usa partida.js, le da tiempo a los clientes a mostrar el resultado.
const PAUSA_FIN_DE_MANO_MS = 1400;

// Asientos 0..3 en orden horario. Los compañeros de equipo se sientan
// SIEMPRE enfrentados (nunca al lado) — mismo criterio que ya usa el lobby
// de salas (scripts/entities/asiento.gd): equipo = asiento % 2.
function equipoDe(asiento) {
  return asiento % 2;
}

class PartidaEquipos extends EventEmitter {
  constructor(puntosObjetivo = 30) {
    super();
    this.puntosObjetivo = puntosObjetivo;
    this.mazo = new Mazo();
    this.maquina = new StateMachine();
    this.maquina.onEstadoCambio((_de, a) => this.emit('estadoCambiado', a));

    this.puntos = { 0: 0, 1: 0 }; // por EQUIPO, no por asiento

    this.mano = { 0: [], 1: [], 2: [], 3: [] };
    // Copia fija de la mano de 3 cartas tal como se repartió, para el
    // cálculo de Envido — igual que en partida.js.
    this.manoEnvido = { 0: [], 1: [], 2: [], 3: [] };

    this.repartidor = 3; // rota cada mano; arranca en 3 => Mano = asiento 0
    this.turnoActual = 0;
    this._idosAlMazo = new Set(); // asientos que ya se fueron al mazo esta mano

    this.rondaActual = 1;
    this.resultadosRondas = []; // -1 parda, o equipo (0/1) ganador de la ronda
    this._quienIniciaRonda = 0; // asiento
    this._cartasJugadasRonda = {}; // asiento -> carta

    this.envidoResuelto = false;
    this._cantoEnvidoPendiente = '';
    this._quienCantoEnvido = -1; // asiento
    this._cadenaEnvido = [];
    this._trucoInterrumpidoPorEnvido = false;

    // Fase de declaración de envido (después de "Quiero") — sección 17: el
    // Mano declara primero su puntaje real; a partir de ahí habla siempre
    // el EQUIPO QUE VA PERDIENDO, con su próximo jugador sin hablar todavía
    // (en orden de mesa arrancando en Mano). El equipo que va ganando se
    // queda callado — no "pasa su turno", directamente no le toca.
    this._declarandoEnvido = false;
    this._colaEquipo = { 0: [], 1: [] }; // asientos de cada equipo que todavía no hablaron, en orden de mesa
    this._turnoDeclaracionActual = -1;
    this._mejorDeclarado = -1;
    this._equipoMejorDeclarado = -1;
    this._declaraciones = {}; // asiento -> número declarado | null (son buenas)

    this.trucoNivel = 0; // 0 = sin canto, 1 = truco, 2 = retruco, 3 = vale cuatro
    this._quienCantoTruco = -1; // asiento
    // A diferencia de partida.js (1v1), acá lo que "tiene el turno de
    // responder/subir" es un EQUIPO completo (sección 17: "cualquiera de
    // los 2 compañeros puede responder; en cuanto uno responde, la decisión
    // queda cerrada para los 2").
    this._equipoDebeResponderTruco = -1;
    this._equipoPuedeSubirTruco = -1;

    this._finDeManoTimeoutId = null;
  }

  rivalEquipo(equipo) {
    return 1 - equipo;
  }

  companeroDe(asiento) {
    return (asiento + 2) % NUM_ASIENTOS;
  }

  getCartaJugadaEnRonda(asiento) {
    return this._cartasJugadasRonda[asiento] || null;
  }

  // Próximo asiento en sentido horario, saltando a quien ya se fue al mazo.
  _siguienteAsiento(desde) {
    let siguiente = (desde + 1) % NUM_ASIENTOS;
    let vueltas = 0;
    while (this._idosAlMazo.has(siguiente) && vueltas < NUM_ASIENTOS) {
      siguiente = (siguiente + 1) % NUM_ASIENTOS;
      vueltas += 1;
    }
    return siguiente;
  }

  // ---------------------------------------------------------
  // Ciclo de partida / mano
  // ---------------------------------------------------------

  iniciarPartida() {
    this.puntos = { 0: 0, 1: 0 };
    this.repartidor = 3;
    this.emit('puntosActualizados', { ...this.puntos });
    this.iniciarMano();
  }

  iniciarMano() {
    this.rondaActual = 1;
    this.resultadosRondas = [];
    this._cartasJugadasRonda = {};
    this._idosAlMazo = new Set();
    this.envidoResuelto = false;
    this._cantoEnvidoPendiente = '';
    this._quienCantoEnvido = -1;
    this._cadenaEnvido = [];
    this._trucoInterrumpidoPorEnvido = false;
    this._declarandoEnvido = false;
    this._colaEquipo = { 0: [], 1: [] };
    this._turnoDeclaracionActual = -1;
    this._mejorDeclarado = -1;
    this._equipoMejorDeclarado = -1;
    this._declaraciones = {};
    this.trucoNivel = 0;
    this._quienCantoTruco = -1;
    this._equipoDebeResponderTruco = -1;
    this._equipoPuedeSubirTruco = -1;

    const mano = (this.repartidor + 1) % NUM_ASIENTOS; // Mano = a la derecha del repartidor
    this._quienIniciaRonda = mano;
    this.turnoActual = mano;

    this.mazo.barajar();
    for (let asiento = 0; asiento < NUM_ASIENTOS; asiento++) {
      this.mano[asiento] = this.mazo.repartir(3);
      this.manoEnvido[asiento] = [...this.mano[asiento]];
    }

    this.maquina.transicionar(Estado.ESPERANDO_JUGADA);
    // manoRepartida lleva la mano completa de los 4 asientos — quien
    // reenvía esto (room-manager.js) es responsable de mandarle a cada
    // socket SOLO su propia mano + la de su compañero (nunca las del
    // equipo rival, sección 17: "poder ver las cartas de mi compañero").
    this.emit('manoRepartida', { ...this.mano });
    this.emit('turnoCambiado', this.turnoActual);
  }

  // ---------------------------------------------------------
  // Tirar carta / evaluar ronda
  // ---------------------------------------------------------

  jugarCarta(asiento, cardId) {
    if (this._idosAlMazo.has(asiento)) return false;
    if (asiento !== this.turnoActual) return false;
    if (!puedeCantar('TIRAR_CARTA', this.maquina.estadoActual, true, this.rondaActual, this.envidoResuelto)) {
      return false;
    }

    const mano = this.mano[asiento];
    const idx = mano.findIndex((c) => c.id === cardId);
    if (idx === -1) return false;
    const [carta] = mano.splice(idx, 1);
    this._cartasJugadasRonda[asiento] = carta;
    this.emit('cartaJugada', asiento, carta);

    if (this._rondaCompleta()) {
      this.maquina.transicionar(Estado.EVALUANDO_MESA);
      this._resolverRonda();
      this._cartasJugadasRonda = {};
      return true;
    }

    this.turnoActual = this._siguienteAsiento(asiento);
    this.emit('turnoCambiado', this.turnoActual);
    return true;
  }

  // La ronda está completa cuando ya jugó carta todo el que sigue activo
  // (los idos al mazo no tienen que tirar más).
  _rondaCompleta() {
    const activos = NUM_ASIENTOS - this._idosAlMazo.size;
    return Object.keys(this._cartasJugadasRonda).length >= activos;
  }

  // Compara la mejor carta de cada EQUIPO en la ronda actual (no hace falta
  // comparar contra el compañero: dos cartas del mismo equipo nunca compiten
  // entre sí) y avanza el flujo.
  _resolverRonda() {
    const mejorEquipo = { 0: -1, 1: -1 };
    const asientoMejorEquipo = { 0: -1, 1: -1 };
    for (const [asientoStr, carta] of Object.entries(this._cartasJugadasRonda)) {
      const asiento = Number(asientoStr);
      const equipo = equipoDe(asiento);
      if (carta.jerarquia_truco > mejorEquipo[equipo]) {
        mejorEquipo[equipo] = carta.jerarquia_truco;
        asientoMejorEquipo[equipo] = asiento;
      }
    }

    let equipoGanador = -1;
    let asientoGanador = -1;
    if (mejorEquipo[0] > mejorEquipo[1]) {
      equipoGanador = 0;
      asientoGanador = asientoMejorEquipo[0];
    } else if (mejorEquipo[1] > mejorEquipo[0]) {
      equipoGanador = 1;
      asientoGanador = asientoMejorEquipo[1];
    }

    const esParda = equipoGanador === -1;
    this.resultadosRondas.push(equipoGanador);
    this.emit('rondaResuelta', equipoGanador, esParda);

    // Quién arranca la siguiente ronda (sección 9, extendida en sección 17:
    // "sigue sentido horario desde" el asiento que ganó — no solo el equipo).
    if (esParda) {
      if (this.rondaActual === 1) {
        this._quienIniciaRonda = (this.repartidor + 1) % NUM_ASIENTOS; // Mano
      }
      // parda en ronda 2: _quienIniciaRonda no cambia
    } else {
      this._quienIniciaRonda = asientoGanador;
    }

    const ganadorMano = this._chequearGanadorMano();
    if (ganadorMano !== -1) {
      this._sumarPuntos(ganadorMano, this._puntosTrucoActuales());
      this._finDeMano(ganadorMano);
      return;
    }

    if (this.rondaActual >= 3) {
      const ganadorDefault = equipoDe((this.repartidor + 1) % NUM_ASIENTOS); // equipo del Mano
      this._sumarPuntos(ganadorDefault, this._puntosTrucoActuales());
      this._finDeMano(ganadorDefault);
      return;
    }

    this.rondaActual += 1;
    this.turnoActual = this._quienIniciaRonda;
    this.maquina.transicionar(Estado.ESPERANDO_JUGADA);
    this.emit('turnoCambiado', this.turnoActual);
  }

  _puntosTrucoActuales() {
    if (this.trucoNivel === 0) return 1;
    const cantoActual = ORDEN_TRUCO[this.trucoNivel - 1];
    return Constants.PUNTOS_TRUCO[cantoActual] || 1;
  }

  // Determina si ya hay equipo ganador de la mano (sección 9, por EQUIPO en
  // vez de por jugador — misma lógica que partida.js).
  _chequearGanadorMano() {
    const n = this.resultadosRondas.length;
    if (n < 2) return -1;

    const r1 = this.resultadosRondas[0];
    const r2 = this.resultadosRondas[1];

    if (n === 2) {
      if (r1 === -1) return r2 !== -1 ? r2 : -1;
      if (r2 === -1) return r1;
      if (r1 === r2) return r1;
      return -1;
    }

    const r3 = this.resultadosRondas[2];
    if (r3 !== -1) return r3;
    // Ronda 3 también parda — mismo criterio que partida.js (1v1): si ronda 1
    // tuvo ganador, ronda 1 y ronda 2 fueron necesariamente 1 a 1 (único
    // camino que deja la mano sin decidir en n===2 con r1 con ganador), y ahí
    // gana el equipo que ganó la PRIMERA ronda, no "el Mano" (sección 9).
    if (r1 !== -1) return r1;
    // r1 y r2 fueron parda-parda, y ahora también la ronda 3: recién en un
    // triple empate desempata el equipo del Mano (sección 9).
    return equipoDe((this.repartidor + 1) % NUM_ASIENTOS);
  }

  // ---------------------------------------------------------
  // Envido
  // ---------------------------------------------------------

  cantarEnvido(asiento, tipo) {
    if (this._idosAlMazo.has(asiento)) return false;
    const estado = this.maquina.estadoActual;
    const interrumpeTruco = estado === Estado.RESOLVIENDO_TRUCO;
    // Interrumpir un Truco sin responder: cualquiera de los 2 del equipo
    // contrario al que cantó ese Truco (sección 6 y 17).
    if (interrumpeTruco && equipoDe(asiento) === equipoDe(this._quienCantoTruco)) return false;
    // Fuera de una interrupción, solo puede abrir quien tiene el turno.
    if (!interrumpeTruco && asiento !== this.turnoActual) return false;
    if (!puedeCantar(tipo, estado, true, this.rondaActual, this.envidoResuelto)) return false;

    this._trucoInterrumpidoPorEnvido = interrumpeTruco;
    this._cadenaEnvido = [tipo];
    this._cantoEnvidoPendiente = tipo;
    this._quienCantoEnvido = asiento;
    this.emit('cantoRealizado', tipo, asiento);
    this.maquina.transicionar(Estado.RESOLVIENDO_ENVIDO);
    return true;
  }

  puedeEscalarEnvido(tipo) {
    return this.maquina.estadoActual === Estado.RESOLVIENDO_ENVIDO && puedeSubirEnvido(this._cadenaEnvido, tipo);
  }

  escalarEnvido(asiento, tipo) {
    if (this._idosAlMazo.has(asiento)) return false;
    if (this.maquina.estadoActual !== Estado.RESOLVIENDO_ENVIDO) return false;
    // Solo puede subir el EQUIPO contrario al que hizo el último canto
    // (sección 6: "una vez que alguien del equipo contrario respondió, solo
    // ese equipo puede seguir subiendo").
    if (equipoDe(asiento) === equipoDe(this._quienCantoEnvido)) return false;
    if (!puedeSubirEnvido(this._cadenaEnvido, tipo)) return false;

    this._cadenaEnvido.push(tipo);
    this._cantoEnvidoPendiente = tipo;
    this._quienCantoEnvido = asiento;
    this.emit('cantoRealizado', tipo, asiento);
    this.maquina.transicionar(Estado.RESOLVIENDO_ENVIDO);
    return true;
  }

  responderEnvido(asiento, quiero) {
    // Cualquier jugador del equipo contrario al que cantó puede responder
    // (sección 6: "no solo el que tiene el turno") — pero no si ese jugador
    // puntual ya se fue al mazo (sección 10: quien se va al mazo deja de
    // poder cantar o responder nada por su equipo).
    if (this._idosAlMazo.has(asiento)) return false;
    if (equipoDe(asiento) === equipoDe(this._quienCantoEnvido)) return false;
    const accion = quiero ? 'QUIERO' : 'NO_QUIERO';
    if (!puedeCantar(accion, this.maquina.estadoActual, false, this.rondaActual, this.envidoResuelto)) return false;

    if (!quiero) {
      this.envidoResuelto = true;
      this.emit('cantoRealizado', 'NO_QUIERO', asiento);
      const puntosNoQuerido = this._cadenaEnvido.length;
      const equipoGanador = equipoDe(this._quienCantoEnvido);
      this._sumarPuntos(equipoGanador, puntosNoQuerido);
      this.emit('envidoTerminado', {
        declaraciones: {},
        ganadorEquipo: equipoGanador,
        puntosEnJuego: puntosNoQuerido,
        revelado: false,
      });
      this._cerrarEnvido();
      return true;
    }

    this.envidoResuelto = true;
    this.emit('cantoRealizado', 'QUIERO', asiento);
    this._iniciarDeclaracionEnvido();
    return true;
  }

  // Arranca la fase de declaración (sección 17): el Mano abre, en orden de
  // mesa saltando a quien ya se fue al mazo. De ahí en más el turno NO es
  // un recorrido fijo de asientos — habla siempre el equipo que va
  // perdiendo (ver _registrarDeclaracion).
  _iniciarDeclaracionEnvido() {
    this._declarandoEnvido = true;
    this._mejorDeclarado = -1;
    this._equipoMejorDeclarado = -1;
    this._declaraciones = {};

    const mano = (this.repartidor + 1) % NUM_ASIENTOS;
    this._colaEquipo = { 0: [], 1: [] };
    for (let i = 0; i < NUM_ASIENTOS; i++) {
      const asiento = (mano + i) % NUM_ASIENTOS;
      if (!this._idosAlMazo.has(asiento)) this._colaEquipo[equipoDe(asiento)].push(asiento);
    }
    this._turnoDeclaracionActual = this._colaEquipo[equipoDe(mano)].shift();
    this.emit('envidoDeclaracionTurno', this._turnoDeclaracionActual);
  }

  _puedeDeclarar(asiento) {
    return this._declarandoEnvido && this._turnoDeclaracionActual === asiento;
  }

  // El valor declarado SIEMPRE es el puntaje real del jugador (el servidor
  // ya lo conoce por manoEnvido) — no se confía en ningún número que mande
  // el cliente, así nadie puede mentir para arriba. Solo es válido si supera
  // el mejor anunciado hasta el momento (sección 17).
  declararEnvido(asiento) {
    if (!this._puedeDeclarar(asiento)) return false;
    const miPuntaje = calcularEnvido(this.manoEnvido[asiento]);
    if (miPuntaje <= this._mejorDeclarado) return false;
    this._registrarDeclaracion(asiento, miPuntaje);
    return true;
  }

  // "Son buenas": el primero en hablar (el Mano) no puede pasar, tiene que
  // declarar un número real — no hay nada previo con qué compararse.
  sonBuenas(asiento) {
    if (!this._puedeDeclarar(asiento)) return false;
    if (this._mejorDeclarado === -1) return false;
    this._registrarDeclaracion(asiento, null);
    return true;
  }

  // El equipo que va ganando espera: no habla de nuevo hasta que el rival
  // lo supere. Por eso el próximo en hablar siempre sale de la cola del
  // equipo que va PERDIENDO (nunca de la cola del propio equipo líder) —
  // si a ese equipo no le queda nadie sin hablar, ya no puede superar al
  // líder y la declaración termina ahí, sin preguntarle nada a nadie más.
  _registrarDeclaracion(asiento, valor) {
    this._declaraciones[asiento] = valor;
    if (valor !== null && valor > this._mejorDeclarado) {
      this._mejorDeclarado = valor;
      this._equipoMejorDeclarado = equipoDe(asiento);
    }
    this.emit('envidoDeclarado', asiento, valor);

    const equipoQuePierde = this._equipoMejorDeclarado === 0 ? 1 : 0;
    if (this._colaEquipo[equipoQuePierde].length === 0) {
      this._resolverDeclaracionEnvido();
      return;
    }
    this._turnoDeclaracionActual = this._colaEquipo[equipoQuePierde].shift();
    this.emit('envidoDeclaracionTurno', this._turnoDeclaracionActual);
  }

  _resolverDeclaracionEnvido() {
    this._declarandoEnvido = false;
    // _equipoMejorDeclarado siempre queda seteado acá: el Mano (primero en
    // hablar) está obligado a declarar un número real, así que como mínimo
    // su equipo ya quedó anotado como "mejor hasta el momento".
    const equipoGanador = this._equipoMejorDeclarado;

    const ultimoCanto = this._cadenaEnvido[this._cadenaEnvido.length - 1];
    let puntos;
    if (ultimoCanto === 'FALTA_ENVIDO') {
      const ptsLider = Math.max(this.puntos[0], this.puntos[1]);
      puntos = Constants.calcularFaltaEnvido(this.puntosObjetivo, ptsLider);
    } else {
      puntos = this._cadenaEnvido.reduce((acc, canto) => acc + (Constants.PUNTOS_ENVIDO[canto] || 0), 0);
    }
    this._sumarPuntos(equipoGanador, puntos);
    this.emit('envidoTerminado', {
      declaraciones: { ...this._declaraciones },
      ganadorEquipo: equipoGanador,
      puntosEnJuego: puntos,
      revelado: true,
    });
    this._cerrarEnvido();
  }

  _cerrarEnvido() {
    this._cantoEnvidoPendiente = '';
    this._quienCantoEnvido = -1;
    this._cadenaEnvido = [];
    this._colaEquipo = { 0: [], 1: [] };
    this._turnoDeclaracionActual = -1;

    if (this.puntos[0] >= this.puntosObjetivo || this.puntos[1] >= this.puntosObjetivo) {
      this._trucoInterrumpidoPorEnvido = false;
      const ganadorPartida = this.puntos[0] >= this.puntosObjetivo ? 0 : 1;
      this._finDeMano(ganadorPartida);
      return;
    }

    if (this._trucoInterrumpidoPorEnvido) {
      this._trucoInterrumpidoPorEnvido = false;
      this.maquina.transicionar(Estado.RESOLVIENDO_TRUCO);
    } else {
      this.maquina.transicionar(Estado.ESPERANDO_JUGADA);
    }
  }

  // ---------------------------------------------------------
  // Truco
  // ---------------------------------------------------------

  cantarTruco(asiento) {
    if (this._idosAlMazo.has(asiento)) return false;
    if (this.trucoNivel !== 0) return false;
    if (asiento !== this.turnoActual) return false;
    if (!puedeCantar('TRUCO', this.maquina.estadoActual, true, this.rondaActual, this.envidoResuelto)) return false;

    this.trucoNivel = 1;
    this._quienCantoTruco = asiento;
    this._equipoDebeResponderTruco = this.rivalEquipo(equipoDe(asiento));
    this._equipoPuedeSubirTruco = -1;
    this.emit('cantoRealizado', 'TRUCO', asiento);
    this.maquina.transicionar(Estado.RESOLVIENDO_TRUCO);
    return true;
  }

  // ¿El EQUIPO de asiento puede subir la apuesta ahora mismo, jugando con
  // normalidad? (sección 8, extendida por sección 17: cualquiera de los 2
  // compañeros que "tienen el quiero" puede hacerlo, en cualquier ronda).
  puedeSubirTruco(asiento) {
    return (
      this.maquina.estadoActual === Estado.ESPERANDO_JUGADA &&
      this.trucoNivel > 0 &&
      this.trucoNivel < ORDEN_TRUCO.length &&
      !this._idosAlMazo.has(asiento) &&
      equipoDe(asiento) === this._equipoPuedeSubirTruco
    );
  }

  subirTruco(asiento) {
    if (!this.puedeSubirTruco(asiento)) return false;
    this.trucoNivel += 1;
    this._quienCantoTruco = asiento;
    this._equipoDebeResponderTruco = this.rivalEquipo(equipoDe(asiento));
    this._equipoPuedeSubirTruco = -1;
    this.emit('cantoRealizado', ORDEN_TRUCO[this.trucoNivel - 1], asiento);
    this.maquina.transicionar(Estado.RESOLVIENDO_TRUCO);
    return true;
  }

  // Cualquiera de los 2 jugadores del equipo que debe responder puede
  // hacerlo — la primera respuesta válida cierra la decisión para los 2
  // (sección 17). Como el chequeo es por EQUIPO (no por asiento exacto como
  // en partida.js), alcanza con comparar equipoDe(asiento) acá.
  responderTruco(asiento, quiero, subir = false) {
    // Mismo criterio que responderEnvido: el equipo puede tener el turno de
    // respuesta, pero si este jugador puntual ya se fue al mazo no puede
    // ejercerlo (el compañero activo sí puede).
    if (this._idosAlMazo.has(asiento)) return false;
    if (equipoDe(asiento) !== this._equipoDebeResponderTruco) return false;
    const accion = quiero ? 'QUIERO' : 'NO_QUIERO';
    if (!puedeCantar(accion, this.maquina.estadoActual, false, this.rondaActual, this.envidoResuelto)) return false;

    if (!quiero) {
      this.emit('cantoRealizado', 'NO_QUIERO', asiento);
      const cantoActual = ORDEN_TRUCO[this.trucoNivel - 1];
      const puntosNoQuerido = Constants.PUNTOS_NO_QUERIDO_TRUCO[cantoActual] || 1;
      const equipoGanador = equipoDe(this._quienCantoTruco);
      this._sumarPuntos(equipoGanador, puntosNoQuerido);
      this._finDeMano(equipoGanador);
      return true;
    }

    if (subir && this.trucoNivel < ORDEN_TRUCO.length) {
      this.trucoNivel += 1;
      this._quienCantoTruco = asiento;
      this._equipoDebeResponderTruco = this.rivalEquipo(equipoDe(asiento));
      this._equipoPuedeSubirTruco = -1;
      this.emit('cantoRealizado', ORDEN_TRUCO[this.trucoNivel - 1], asiento);
      this.maquina.transicionar(Estado.RESOLVIENDO_TRUCO);
      return true;
    }

    this._equipoPuedeSubirTruco = equipoDe(asiento);
    this._equipoDebeResponderTruco = -1;
    this.emit('cantoRealizado', 'QUIERO', asiento);
    this.maquina.transicionar(Estado.ESPERANDO_JUGADA);
    return true;
  }

  // ---------------------------------------------------------
  // Irse al mazo
  // ---------------------------------------------------------

  irseAlMazo(asiento) {
    if (this._idosAlMazo.has(asiento)) return false;
    if (asiento !== this.turnoActual) return false;
    if (!puedeCantar('IR_AL_MAZO', this.maquina.estadoActual, true, this.rondaActual, this.envidoResuelto)) {
      return false;
    }

    this._idosAlMazo.add(asiento);
    this.emit('cantoRealizado', 'ME_VOY_AL_MAZO', asiento);

    const miEquipo = equipoDe(asiento);
    if (this._idosAlMazo.has(this.companeroDe(asiento))) {
      // Los 2 del equipo ya se fueron: termina la mano a favor del rival
      // (sección 10: "si todos los jugadores del equipo se van al mazo,
      // pierden todos los puntos pendientes").
      const rival = this.rivalEquipo(miEquipo);
      let puntos = 1;
      if (this.trucoNivel > 0) {
        const cantoActual = ORDEN_TRUCO[this.trucoNivel - 1];
        puntos = Constants.PUNTOS_TRUCO[cantoActual] || 1;
      }
      this._sumarPuntos(rival, puntos);
      this._finDeMano(rival);
      return true;
    }

    // El compañero sigue jugando con normalidad (sección 10). Si con este
    // jugador afuera ya no queda nadie más por tirar en la ronda en curso,
    // se resuelve la ronda con lo que ya se jugó; si no, sigue el turno.
    if (this._rondaCompleta()) {
      this.maquina.transicionar(Estado.EVALUANDO_MESA);
      this._resolverRonda();
      this._cartasJugadasRonda = {};
      return true;
    }

    this.turnoActual = this._siguienteAsiento(asiento);
    this.emit('turnoCambiado', this.turnoActual);
    return true;
  }

  // ---------------------------------------------------------
  // Puntos / fin de mano / fin de partida
  // ---------------------------------------------------------

  // Mismo criterio que partida.js (1v1): topeado acá porque una sola suma
  // (Falta Envido, Vale Cuatro) puede pasarse del objetivo — sin el tope, un
  // final a 30 podía terminar mostrando 32.
  _sumarPuntos(equipoGanador, puntos) {
    this.puntos[equipoGanador] = Math.min(this.puntos[equipoGanador] + puntos, this.puntosObjetivo);
    this.emit('puntosActualizados', { ...this.puntos });
  }

  _finDeMano(equipoGanadorMano) {
    this.maquina.transicionar(Estado.FIN_DE_MANO);
    this.emit('manoTerminada', equipoGanadorMano);

    this._finDeManoTimeoutId = setTimeout(() => {
      this._finDeManoTimeoutId = null;
      if (this.puntos[0] >= this.puntosObjetivo || this.puntos[1] >= this.puntosObjetivo) {
        const ganadorPartida = this.puntos[0] >= this.puntosObjetivo ? 0 : 1;
        this.maquina.transicionar(Estado.FIN_PARTIDA);
        this.emit('partidaTerminada', ganadorPartida);
      } else {
        this.repartidor = (this.repartidor + 1) % NUM_ASIENTOS;
        this.iniciarMano();
      }
    }, PAUSA_FIN_DE_MANO_MS);
  }

  // Corta cualquier timer pendiente y desconecta todos los listeners —
  // mismo motivo que en partida.js (evitar mandarle mensajes a una sala
  // que ya nadie escucha).
  destruir() {
    if (this._finDeManoTimeoutId) {
      clearTimeout(this._finDeManoTimeoutId);
      this._finDeManoTimeoutId = null;
    }
    this.removeAllListeners();
  }
}

module.exports = { PartidaEquipos, equipoDe };
