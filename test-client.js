// ============================================================
// Nombre: test-client.js
// Rol: Simula DOS clientes reales hablando el protocolo WebSocket del
//      backend, sin tocar Godot para nada. Sirve para confirmar que la
//      lógica de salas + Partida funciona de punta a punta ANTES de
//      meter la complejidad del cliente 3D.
//
//      "Jugador A" crea una sala 1v1, "Jugador B" la ve y elige el asiento
//      libre, y ambos juegan cartas automáticamente (la primera de su mano
//      en cada turno, sin cantar Envido/Truco) hasta que termina la
//      primera mano. Todo se imprime por consola.
//
// Uso:  node test-client.js            (contra ws://localhost:3000)
//       PORT=4000 node test-client.js  (contra otro puerto)
// ============================================================

const WebSocket = require('ws');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const URL = `ws://localhost:${PORT}`;

class ClienteDePrueba {
  constructor(etiqueta) {
    this.etiqueta = etiqueta; // "A" o "B"
    this.ws = new WebSocket(URL);
    this.seat = null;
    this.mano = [];
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
        this._log(`Sala creada: código=${msg.code} (yo soy el asiento ${msg.seat})`);
        if (this.onSalaCreada) this.onSalaCreada(msg.code);
        break;

      case 'DETALLE_SALA':
        this._log(
          `Detalle de sala ${msg.code}: ${msg.asientos.map((a) => (a.ocupado ? a.nombre : 'libre')).join(' | ')}`
        );
        break;

      case 'ASIENTO_CONFIRMADO':
        this.seat = msg.asiento;
        this._log(`Elegí el asiento ${msg.asiento} en la sala ${msg.code}`);
        break;

      case 'PARTIDA_INICIADA':
        this._log(`¡Partida iniciada! Jugando a ${msg.puntosObjetivo} puntos.`);
        break;

      case 'MANO_REPARTIDA':
        this.mano = msg.mano;
        this._log(`Mano repartida: ${this.mano.map((c) => c.id).join(', ')}`);
        break;

      case 'TURNO_CAMBIADO':
        if (msg.turno === this.seat) this._jugarPrimeraCarta();
        break;

      case 'CARTA_JUGADA':
        this._log(`Jugador${msg.jugador} tiró ${msg.carta.id}`);
        break;

      case 'RONDA_RESUELTA':
        this._log(`Ronda resuelta: ${msg.parda ? 'PARDA' : `gana Jugador${msg.ganador}`}`);
        break;

      case 'MANO_TERMINADA':
        this._log(`>>> Mano terminada: gana Jugador${msg.ganador}`);
        if (this.onManoTerminada) this.onManoTerminada(msg.ganador);
        break;

      case 'PUNTOS_ACTUALIZADOS':
        this._log(`Puntos: Jugador0=${msg.puntosJ1} Jugador1=${msg.puntosJ2}`);
        break;

      case 'PARTIDA_TERMINADA':
        this._log(`### Partida terminada: gana Jugador${msg.ganador}`);
        break;

      case 'ERROR':
        this._log(`ERROR del servidor: ${msg.message}`);
        break;

      default:
        break;
    }
  }

  _jugarPrimeraCarta() {
    if (this.mano.length === 0) return;
    const carta = this.mano.shift();
    this._log(`Es mi turno, tiro ${carta.id}`);
    this.enviar({ type: 'JUGAR_CARTA', cardId: carta.id });
  }

  cerrar() {
    this.ws.close();
  }
}

async function main() {
  console.log(`Conectando dos clientes de prueba a ${URL} ...\n`);

  const jugadorA = new ClienteDePrueba('A');
  const jugadorB = new ClienteDePrueba('B');

  await Promise.all([jugadorA.esperarConexion(), jugadorB.esperarConexion()]);

  const codigoSala = await new Promise((resolve) => {
    jugadorA.onSalaCreada = resolve;
    jugadorA.enviar({ type: 'CREAR_SALA', nombreSala: 'Mesa de prueba', modo: '1v1', nombre: 'Jugador A' });
  });

  jugadorB.enviar({ type: 'VER_SALA', code: codigoSala });
  jugadorB.enviar({ type: 'ELEGIR_ASIENTO', code: codigoSala, asiento: 1, nombre: 'Jugador B' });

  const primeraManoTerminada = new Promise((resolve) => {
    jugadorA.onManoTerminada = resolve;
  });

  const timeout = new Promise((_resolve, reject) =>
    setTimeout(() => reject(new Error('Timeout: la mano no terminó en 15s')), 15000)
  );

  try {
    await Promise.race([primeraManoTerminada, timeout]);
    console.log('\n✅ Test OK: se jugó una mano completa de punta a punta.');
  } catch (err) {
    console.error(`\n❌ Test falló: ${err.message}`);
    process.exitCode = 1;
  } finally {
    jugadorA.cerrar();
    jugadorB.cerrar();
    // Le da un instante a los sockets para cerrar prolijo antes de salir.
    setTimeout(() => process.exit(), 300);
  }
}

main();
