// ============================================================
// Nombre: state_machine.js
// Rol: Máquina de estados pura del flujo de una mano de Truco
// Puerto de: scripts/core/state_machine.gd (mismos 8 estados)
// Fuente: docs/Reglas_Truco_Argentino.md sección 13
// ============================================================

const Estado = Object.freeze({
  INICIO_RONDA: 'INICIO_RONDA',
  ESPERANDO_JUGADA: 'ESPERANDO_JUGADA',
  RESOLVIENDO_ENVIDO: 'RESOLVIENDO_ENVIDO',
  RESOLVIENDO_FLOR: 'RESOLVIENDO_FLOR', // Reservado: Flor desactivada en el MVP
  RESOLVIENDO_TRUCO: 'RESOLVIENDO_TRUCO',
  EVALUANDO_MESA: 'EVALUANDO_MESA',
  FIN_DE_MANO: 'FIN_DE_MANO',
  FIN_PARTIDA: 'FIN_PARTIDA',
});

class StateMachine {
  constructor() {
    this.estadoActual = Estado.INICIO_RONDA;
    this._listeners = [];
  }

  // Análogo a la señal estado_cambio(de, a) de Godot
  onEstadoCambio(callback) {
    this._listeners.push(callback);
  }

  transicionar(nuevoEstado) {
    const estadoAnterior = this.estadoActual;
    this.estadoActual = nuevoEstado;
    for (const cb of this._listeners) cb(estadoAnterior, nuevoEstado);
  }

  es(estado) {
    return this.estadoActual === estado;
  }
}

module.exports = { StateMachine, Estado };
