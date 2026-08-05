// ============================================================
// Nombre: connection-handler.js
// Rol: Parsea los mensajes JSON entrantes de cada socket y los despacha
//      al RoomManager / a la Partida de la sala. El servidor es la ÚNICA
//      fuente de verdad: el "jugadorId" de cada acción es SIEMPRE ws.seat
//      (asignado por el servidor al elegir asiento), nunca un valor que
//      mande el cliente — así un cliente no puede jugar en nombre del rival.
// ============================================================

function enviar(ws, mensaje) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(mensaje));
  }
}

function enviarError(ws, message) {
  enviar(ws, { type: 'ERROR', message });
}

// Acciones que requieren una sala ya completa (partida en curso). DECLARAR_ENVIDO
// y SON_BUENAS son de la fase de declaración en cadena del 2v2 (sección 17) —
// no existen en partida.js (1v1), así que ahí simplemente no van a matchear
// ningún método y quedan como "Acción inválida".
const ACCIONES_DE_JUEGO = new Set([
  'JUGAR_CARTA',
  'CANTAR_ENVIDO',
  'ESCALAR_ENVIDO',
  'RESPONDER_ENVIDO',
  'CANTAR_TRUCO',
  'SUBIR_TRUCO',
  'RESPONDER_TRUCO',
  'IRSE_AL_MAZO',
  'DECLARAR_ENVIDO',
  'SON_BUENAS',
]);

function manejarAccionDeJuego(roomManager, ws, mensaje) {
  const room = roomManager.salaDe(ws);
  if (!room || !room.partida) {
    enviarError(ws, 'Todavía no empezó la partida en esta sala.');
    return;
  }

  const partida = room.partida;
  const jugadorId = ws.seat; // nunca confiar en un id que mande el cliente
  let ok = false;

  switch (mensaje.type) {
    case 'JUGAR_CARTA':
      ok = partida.jugarCarta(jugadorId, mensaje.cardId);
      break;
    case 'CANTAR_ENVIDO':
      // Solo para abrir la cadena (primer canto). Para subir una cadena ya
      // abierta (Envido -> Real Envido -> ...) el cliente manda ESCALAR_ENVIDO.
      ok = partida.cantarEnvido(jugadorId, mensaje.tipo);
      break;
    case 'ESCALAR_ENVIDO':
      ok = partida.escalarEnvido(jugadorId, mensaje.tipo);
      break;
    case 'RESPONDER_ENVIDO':
      ok = partida.responderEnvido(jugadorId, !!mensaje.quiero);
      break;
    case 'CANTAR_TRUCO':
      // Solo para el primer canto de Truco de la mano. Para subir un nivel
      // ya aceptado (Retruco/Vale Cuatro) el cliente manda SUBIR_TRUCO.
      ok = partida.cantarTruco(jugadorId);
      break;
    case 'SUBIR_TRUCO':
      ok = partida.subirTruco(jugadorId);
      break;
    case 'RESPONDER_TRUCO':
      ok = partida.responderTruco(jugadorId, !!mensaje.quiero, !!mensaje.subir);
      break;
    case 'IRSE_AL_MAZO':
      ok = partida.irseAlMazo(jugadorId);
      break;
    case 'DECLARAR_ENVIDO':
      // El puntaje declarado lo calcula el propio motor a partir de la mano
      // real (nunca se confía en un número que mande el cliente).
      ok = typeof partida.declararEnvido === 'function' && partida.declararEnvido(jugadorId);
      break;
    case 'SON_BUENAS':
      ok = typeof partida.sonBuenas === 'function' && partida.sonBuenas(jugadorId);
      break;
    default:
      break;
  }

  if (!ok) {
    enviarError(ws, `Acción inválida: ${mensaje.type}`);
  }
}

// Todo lo que puede tirar una excepción (lógica de salas y de las dos
// partidas, 1v1 y 2v2 — ambas pasan por acá) queda adentro de este try. Sin
// esto, un bug en un solo mensaje de un solo jugador tira abajo el proceso
// entero de Node, y con él TODAS las salas en curso de TODOS los jugadores
// conectados en ese momento (ver DEBUG-RAILWAY.md). Con el try/catch, ese
// jugador recibe un ERROR y el resto de las partidas ni se entera.
function _despacharMensaje(roomManager, ws, mensaje) {
  switch (mensaje.type) {
    case 'CREAR_SALA':
      roomManager.crearSala(ws, {
        nombreSala: mensaje.nombreSala,
        modo: mensaje.modo,
        nombreJugador: mensaje.nombre,
        puntosObjetivo: mensaje.puntosObjetivo,
        personajeId: mensaje.personaje,
      });
      return;

    case 'LISTAR_SALAS':
      enviar(ws, { type: 'LISTA_SALAS', salas: roomManager.listarSalas(mensaje.modo) });
      return;

    case 'VER_SALA':
      roomManager.verSala(ws, mensaje.code);
      return;

    case 'ELEGIR_ASIENTO':
      roomManager.elegirAsiento(ws, mensaje.code, mensaje.asiento, mensaje.nombre, mensaje.personaje);
      return;

    case 'DEJAR_ASIENTO':
      roomManager.dejarAsiento(ws, mensaje.code);
      return;

    case 'SALIR_SALA':
      roomManager.salirSala(ws);
      return;

    // Cosmético (gira la cabeza del modelo 3D hacia donde mira cada
    // jugador) — no es una acción de juego: no pasa por manejarAccionDeJuego
    // ni requiere partida en curso, así que se resuelve acá directo.
    case 'MIRAR':
      roomManager.mirar(ws, mensaje.yaw, mensaje.pitch);
      return;

    // Chat en vivo entre los jugadores sentados en la sala — mismo patrón
    // que MIRAR: puro relay, no pasa por Partida/PartidaEquipos.
    case 'CHAT_MENSAJE':
      roomManager.chat(ws, mensaje.texto);
      return;

    default:
      if (ACCIONES_DE_JUEGO.has(mensaje.type)) {
        manejarAccionDeJuego(roomManager, ws, mensaje);
      } else {
        enviarError(ws, `Tipo de mensaje desconocido: ${mensaje.type}`);
      }
  }
}

function manejarMensaje(roomManager, ws, data) {
  let mensaje;
  try {
    mensaje = JSON.parse(data);
  } catch (err) {
    enviarError(ws, 'Mensaje no es JSON válido.');
    return;
  }

  if (!mensaje || typeof mensaje.type !== 'string') {
    enviarError(ws, 'Falta el campo "type" en el mensaje.');
    return;
  }

  try {
    _despacharMensaje(roomManager, ws, mensaje);
  } catch (err) {
    console.error(`[connection-handler] Error procesando "${mensaje.type}" (asiento=${ws.seat ?? '?'}):`, err);
    enviarError(ws, 'Ocurrió un error procesando esa acción. Probá de nuevo.');
  }
}

function manejarConexion(roomManager, ws) {
  ws.on('message', (data) => manejarMensaje(roomManager, ws, data));
  ws.on('close', () => {
    try {
      roomManager.desconectar(ws);
    } catch (err) {
      console.error('[connection-handler] Error al desconectar:', err);
    }
  });
  ws.on('error', () => {
    try {
      roomManager.desconectar(ws);
    } catch (err) {
      console.error('[connection-handler] Error al desconectar:', err);
    }
  });
}

module.exports = { manejarConexion };
