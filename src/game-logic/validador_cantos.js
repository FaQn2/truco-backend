// ============================================================
// Nombre: validador_cantos.js
// Rol: Determina qué acciones son válidas según el estado actual
// Puerto de: scripts/core/validador_cantos.gd (misma tabla de validación)
// Fuente: docs/Reglas_Truco_Argentino.md sección 15
// ============================================================

const { Estado } = require('./state_machine');

// Orden de la escalada de Envido (sección 6: se puede abrir en cualquier
// escalón, pero una vez cantado un escalón mayor no se puede "bajar").
const TIER_ENVIDO = {
  ENVIDO: 1,
  REAL_ENVIDO: 2,
  FALTA_ENVIDO: 3,
};

// ¿Se puede subir la apuesta de Envido cantando "nuevo" luego de la cadena ya cantada?
// "Envido" se puede repetir mientras el máximo hasta ahora siga siendo Envido
// (Envido -> Envido -> Envido...). Real Envido y Falta Envido solo suben, nunca
// se repiten ni se puede volver a un escalón menor.
function puedeSubirEnvido(cadenaEnvido, nuevo) {
  if (cadenaEnvido.length === 0) return false;
  const ultimo = cadenaEnvido[cadenaEnvido.length - 1];
  if (ultimo === 'FALTA_ENVIDO') return false; // ya no hay nada más arriba
  const tierActual = TIER_ENVIDO[ultimo] || 0;
  const tierNuevo = TIER_ENVIDO[nuevo] || 0;
  if (tierNuevo === 0) return false;
  if (nuevo === 'ENVIDO') return tierActual === 1;
  return tierNuevo > tierActual;
}

function puedeCantar(accion, estado, jugadorEsElQueCanto, ronda, envidoResuelto) {
  switch (accion) {
    case 'TIRAR_CARTA':
      return estado === Estado.ESPERANDO_JUGADA;

    case 'ENVIDO':
    case 'REAL_ENVIDO':
    case 'FALTA_ENVIDO':
      // Solo en ronda 1 y mientras el envido no esté ya resuelto. Se puede
      // abrir mientras se espera jugada, o interrumpiendo un Truco que
      // todavía no fue respondido (sección 6: "el envido está primero").
      return (
        ronda === 1 &&
        !envidoResuelto &&
        [Estado.ESPERANDO_JUGADA, Estado.RESOLVIENDO_TRUCO].includes(estado)
      );

    case 'TRUCO':
      // Cualquier jugador, cualquier ronda, mientras se espera jugada
      return estado === Estado.ESPERANDO_JUGADA;

    case 'QUIERO':
    case 'NO_QUIERO':
    case 'QUIERO_RETRUCO':
    case 'QUIERO_VALE_CUATRO':
      // Solo puede responder (incluida una subida: Retruco / Vale Cuatro)
      // el jugador contrario al que hizo el último canto pendiente.
      // El nivel de apuesta en sí (Truco -> Retruco -> Vale Cuatro) lo
      // controla partida.js, no este validador.
      return (
        !jugadorEsElQueCanto &&
        [Estado.RESOLVIENDO_ENVIDO, Estado.RESOLVIENDO_TRUCO].includes(estado)
      );

    case 'IR_AL_MAZO':
      return estado === Estado.ESPERANDO_JUGADA;

    default:
      return false;
  }
}

module.exports = { puedeSubirEnvido, puedeCantar, TIER_ENVIDO };
