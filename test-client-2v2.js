// ============================================================
// Nombre: test-client-2v2.js
// Rol: Simula CUATRO clientes reales hablando el protocolo WebSocket del
//      backend para validar el motor 2v2 (partida_equipos.js) de punta a
//      punta, sin tocar Godot — mismo espíritu que test-client.js (1v1),
//      pero ejercitando lo que es nuevo del modo equipos:
//        - reparto con la mano del compañero incluida (nunca la del rival)
//        - envido en cadena: A abre, B (equipo contrario) dice Quiero, y
//          los 4 declaran en orden — cada uno declara su puntaje real si
//          supera al mejor anunciado, o dice "Son buenas" si no
//        - Truco respondido por el COMPAÑERO de quien "debería" responder,
//          no por quien tiene el turno de tirar carta
//
// Uso:  node test-client-2v2.js            (contra ws://localhost:3000)
//       PORT=4000 node test-client-2v2.js  (contra otro puerto)
// ============================================================

const WebSocket = require('ws');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const URL = `ws://localhost:${PORT}`;

const equipoDe = (asiento) => asiento % 2;

// Réplica mínima de calculador_envido.js — cada cliente de prueba necesita
// saber su propio puntaje real para decidir si puede declarar más alto que
// el mejor anunciado o si tiene que decir "Son buenas" (el servidor rechaza
// una declaración que no supere el mejor, así que declarar a ciegas no sirve).
function calcularEnvidoLocal(mano) {
  const porPalo = {};
  for (const carta of mano) {
    const valor = carta.valor >= 10 ? 0 : carta.valor;
    if (!porPalo[carta.palo]) porPalo[carta.palo] = [];
    porPalo[carta.palo].push(valor);
  }
  let mejor = 0;
  for (const palo in porPalo) {
    const valores = [...porPalo[palo]].sort((a, b) => b - a);
    if (valores.length >= 2) mejor = Math.max(mejor, valores[0] + valores[1] + 20);
    else mejor = Math.max(mejor, valores[0]);
  }
  return mejor;
}

class ClienteDePrueba {
  constructor(etiqueta) {
    this.etiqueta = etiqueta;
    this.ws = new WebSocket(URL);
    this.seat = null;
    this.mano = [];
    this.manoCompanero = [];
    this._turnoConocido = -1;
    this._estadoActual = null;
    this.ws.on('message', (data) => this._onMensaje(JSON.parse(data)));
    this.ws.on('error', (err) => this._log(`ERROR de socket: ${err.message}`));
  }

  _log(msg) {
    console.log(`[${this.etiqueta}] ${msg}`);
  }

  esperarConexion() {
    return new Promise((resolve) => this.ws.on('open', resolve));
  }

  enviar(mensaje) {
    this.ws.send(JSON.stringify(mensaje));
  }

  _onMensaje(msg) {
    switch (msg.type) {
      case 'SALA_CREADA':
        this.seat = msg.seat;
        if (this.onSalaCreada) this.onSalaCreada(msg.code);
        break;

      case 'ASIENTO_CONFIRMADO':
        this.seat = msg.asiento;
        this._log(`Asiento ${msg.asiento} confirmado en la sala ${msg.code}`);
        break;

      case 'PARTIDA_INICIADA':
        this._log(`Partida 2v2 iniciada a ${msg.puntosObjetivo} puntos — nombres: ${JSON.stringify(msg.nombres)}`);
        break;

      case 'MANO_REPARTIDA':
        this.mano = msg.mano;
        this.manoCompanero = msg.manoCompanero;
        this._log(
          `Mano: ${this.mano.map((c) => c.id).join(', ')} | Compañero: ${this.manoCompanero.map((c) => c.id).join(', ')}`
        );
        if (this.onManoRepartida) this.onManoRepartida();
        break;

      case 'TURNO_CAMBIADO':
        this._turnoConocido = msg.turno;
        if (msg.turno === this.seat && this.onMiTurno) this.onMiTurno();
        break;

      case 'ESTADO_CAMBIADO': {
        // Cantar Truco/Envido no pasa el turno (no dispara TURNO_CAMBIADO) —
        // cuando el estado vuelve a ESPERANDO_JUGADA DESDE un canto en danza
        // (RESOLVIENDO_TRUCO/RESOLVIENDO_ENVIDO) hay que revisar si me sigue
        // tocando a mí. Importante: NO hacer este chequeo después de
        // EVALUANDO_MESA (fin de ronda) — ahí SIEMPRE viene un
        // TURNO_CAMBIADO fresco a continuación, y todavía no llegó cuando
        // procesamos este mensaje — reaccionar acá con el _turnoConocido
        // viejo haría que el que jugó la última carta de la ronda anterior
        // "juegue de nuevo" antes de que se sepa a quién le toca en verdad.
        const anterior = this._estadoActual;
        this._estadoActual = msg.estado;
        const reanudaTrasCanto =
          msg.estado === 'ESPERANDO_JUGADA' &&
          (anterior === 'RESOLVIENDO_TRUCO' || anterior === 'RESOLVIENDO_ENVIDO');
        if (reanudaTrasCanto && this._turnoConocido === this.seat && this.onMiTurno) {
          this.onMiTurno();
        }
        break;
      }

      case 'CARTA_JUGADA':
        this._log(`Asiento ${msg.jugador} tiró ${msg.carta.id}`);
        break;

      case 'RONDA_RESUELTA':
        this._log(`Ronda resuelta: ${msg.parda ? 'PARDA' : `gana equipo ${msg.ganadorEquipo}`}`);
        break;

      case 'CANTO_REALIZADO':
        this._log(`Asiento ${msg.jugador} cantó ${msg.tipo}`);
        if (this.onCanto) this.onCanto(msg.tipo, msg.jugador);
        break;

      case 'ENVIDO_DECLARACION_TURNO':
        if (msg.asiento === this.seat && this.onMiDeclaracion) this.onMiDeclaracion();
        break;

      case 'ENVIDO_DECLARADO':
        this._log(`Asiento ${msg.asiento} declaró: ${msg.valor === null ? 'Son buenas' : msg.valor}`);
        if (this.onDeclarado) this.onDeclarado(msg.valor);
        break;

      case 'ENVIDO_TERMINADO':
        this._log(
          `Envido terminado — declaraciones=${JSON.stringify(msg.declaraciones)} → gana equipo ${msg.ganadorEquipo} (+${msg.puntosEnJuego}, revelado=${msg.revelado})`
        );
        break;

      case 'MANO_TERMINADA':
        this._log(`>>> Mano terminada: gana equipo ${msg.ganadorEquipo}`);
        if (this.onManoTerminada) this.onManoTerminada(msg.ganadorEquipo);
        break;

      case 'PUNTOS_ACTUALIZADOS':
        this._log(`Puntos — EquipoA=${msg.puntosEquipoA} EquipoB=${msg.puntosEquipoB}`);
        break;

      case 'ERROR':
        this._log(`ERROR del servidor: ${msg.message}`);
        break;

      default:
        break;
    }
  }

  jugarPrimeraCarta() {
    if (this.mano.length === 0) return;
    const carta = this.mano.shift();
    this._log(`Tiro ${carta.id}`);
    this.enviar({ type: 'JUGAR_CARTA', cardId: carta.id });
  }

  cerrar() {
    this.ws.close();
  }
}

async function main() {
  console.log(`Conectando 4 clientes de prueba (2v2) a ${URL} ...\n`);

  const jugadores = ['A', 'B', 'C', 'D'].map((etq) => new ClienteDePrueba(etq));
  const [A, B, C, D] = jugadores;

  await Promise.all(jugadores.map((c) => c.esperarConexion()));

  const code = await new Promise((resolve) => {
    A.onSalaCreada = resolve;
    A.enviar({ type: 'CREAR_SALA', nombreSala: 'Mesa 2v2 test', modo: '2v2', nombre: 'A' });
  });

  // Todos los handlers reactivos hay que engancharlos ANTES de sentar al
  // último jugador: en cuanto la sala se llena, el servidor dispara
  // MANO_REPARTIDA + TURNO_CAMBIADO en cascada de forma prácticamente
  // inmediata — si los engancho después (por ejemplo tras un await), el
  // TURNO_CAMBIADO ya pasó y nadie reacciona.
  let envidoResuelto = false;
  let trucoScripteado = false;

  // El primer turno debería ser el asiento 0 (Mano, ya que el repartidor
  // arranca en 3) — A abre Envido en vez de tirar carta.
  A.onMiTurno = () => {
    if (!envidoResuelto) {
      A._log('Canto ENVIDO en mi turno (en vez de tirar carta)');
      A.enviar({ type: 'CANTAR_ENVIDO', tipo: 'ENVIDO' });
      return;
    }
    A.jugarPrimeraCarta();
  };
  [B, C, D].forEach((c) => { c.onMiTurno = () => c.jugarPrimeraCarta(); });

  // Declaración en cadena (sección 17): cada uno declara su puntaje real
  // SOLO si supera el mejor anunciado hasta el momento (si no, el servidor
  // lo rechaza — no tiene sentido declarar un número que no gana nada), y
  // dice "Son buenas" en caso contrario. mejorDeclarado arranca en -1 (el
  // Mano siempre declara, nunca tiene nada que superar todavía).
  let mejorDeclarado = -1;
  jugadores.forEach((c) => {
    c.onDeclarado = (valor) => {
      if (valor !== null && valor > mejorDeclarado) mejorDeclarado = valor;
    };
    c.onMiDeclaracion = () => {
      const miPuntaje = calcularEnvidoLocal(c.mano);
      if (miPuntaje > mejorDeclarado) {
        c._log(`Declaro mi envido (${miPuntaje} > mejor actual ${mejorDeclarado})`);
        c.enviar({ type: 'DECLARAR_ENVIDO' });
      } else {
        c._log(`Son buenas (mi envido ${miPuntaje} no supera el mejor actual ${mejorDeclarado})`);
        c.enviar({ type: 'SON_BUENAS' });
      }
    };
  });

  // Un solo cliente (A) hace de "árbitro" reactivo — si los 4 compartieran
  // el mismo handler, cada uno dispararía la respuesta por duplicado al
  // recibir el mismo CANTO_REALIZADO.
  A.onCanto = (tipo, jugadorAsiento) => {
    if (tipo === 'ENVIDO' && !envidoResuelto) {
      envidoResuelto = true;
      B._log('Respondo QUIERO al envido (equipo contrario a A)');
      B.enviar({ type: 'RESPONDER_ENVIDO', quiero: true });

      // De acá en más, quien tenga el turno canta Truco UNA vez (en vez de
      // tirar carta) apenas se reanude el juego tras el envido.
      jugadores.forEach((c) => {
        c.onMiTurno = () => {
          if (!trucoScripteado) {
            trucoScripteado = true;
            c._log('Canto TRUCO en vez de tirar carta');
            c.enviar({ type: 'CANTAR_TRUCO' });
            return;
          }
          c.jugarPrimeraCarta();
        };
      });
    }

    if (tipo === 'TRUCO') {
      // Responde el COMPAÑERO de quien "debería" (no el que tiene el turno
      // de tirar carta) — ejercita "cualquiera de los 2 responde por el equipo".
      const equipoResponde = 1 - equipoDe(jugadorAsiento);
      const companeros = jugadores.filter((c) => equipoDe(c.seat) === equipoResponde);
      const elegido = companeros[1];
      elegido._log(`Respondo QUIERO al Truco (compañero, equipo ${equipoResponde})`);
      elegido.enviar({ type: 'RESPONDER_TRUCO', quiero: true });
    }
  };

  // Asientos 0/2 = equipo A, 1/3 = equipo B (equipoDe = asiento % 2) — en
  // cuanto los 4 recibieron su MANO_REPARTIDA, confirma que cada uno tiene
  // la mano REAL de su compañero (nunca la de un rival).
  let companeroOk = null;
  let reparticionesRecibidas = 0;
  jugadores.forEach((c) => {
    c.onManoRepartida = () => {
      reparticionesRecibidas += 1;
      if (reparticionesRecibidas < 4) return;
      const idsDe = (mano) => mano.map((carta) => carta.id).sort().join(',');
      companeroOk =
        idsDe(A.manoCompanero) === idsDe(C.mano) &&
        idsDe(C.manoCompanero) === idsDe(A.mano) &&
        idsDe(B.manoCompanero) === idsDe(D.mano) &&
        idsDe(D.manoCompanero) === idsDe(B.mano);
      console.log(
        companeroOk
          ? '\n✅ manoCompanero coincide con la mano real del compañero en los 4.\n'
          : '\n❌ manoCompanero NO coincide — revisar reparto.\n'
      );
    };
  });

  const manoTerminada = new Promise((resolve) => { A.onManoTerminada = resolve; });
  const timeout = new Promise((_resolve, reject) =>
    setTimeout(() => reject(new Error('Timeout: la mano 2v2 no terminó en 20s')), 20000)
  );

  // Recién ahora, con TODOS los handlers reactivos ya enganchados, se llena
  // la sala — sentar al último jugador dispara MANO_REPARTIDA + TURNO_CAMBIADO
  // de inmediato.
  for (const [cliente, asiento] of [
    [B, 1],
    [C, 2],
    [D, 3],
  ]) {
    cliente.enviar({ type: 'VER_SALA', code });
    cliente.enviar({ type: 'ELEGIR_ASIENTO', code, asiento, nombre: cliente.etiqueta });
    await new Promise((r) => setTimeout(r, 150));
  }

  try {
    await Promise.race([manoTerminada, timeout]);
    console.log('\n✅ Test 2v2 OK: mano completa (envido en cadena + truco respondido por el compañero) de punta a punta.');
    if (companeroOk === false) process.exitCode = 1;
  } catch (err) {
    console.error(`\n❌ Test 2v2 falló: ${err.message}`);
    process.exitCode = 1;
  } finally {
    jugadores.forEach((c) => c.cerrar());
    setTimeout(() => process.exit(), 300);
  }
}

main();
