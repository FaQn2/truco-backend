// ============================================================
// Nombre: calculador_envido.js
// Rol: Calcula el puntaje de Envido de una mano de 3 cartas
// Puerto de: scripts/core/calculador_envido.gd (mismos 4 casos)
// Fuente: docs/Reglas_Truco_Argentino.md sección 3
// ============================================================

const { getValorEnvido } = require('./constants');

// Caso 1/2 (dos o tres cartas del mismo palo): las 2 más altas de ese palo + 20.
// Caso 3 (todas de distinto palo): vale la carta más alta, sin +20.
// Caso 4 (todas figuras de distinto palo): 0.
function calcular(mano) {
  const porPalo = {};
  for (const carta of mano) {
    const palo = carta.palo;
    if (!porPalo[palo]) porPalo[palo] = [];
    porPalo[palo].push(getValorEnvido(carta.valor));
  }

  let mejorPuntaje = 0;
  for (const palo in porPalo) {
    const valores = [...porPalo[palo]].sort((a, b) => b - a);

    if (valores.length >= 2) {
      const puntaje = valores[0] + valores[1] + 20;
      mejorPuntaje = Math.max(mejorPuntaje, puntaje);
    } else if (valores.length === 1) {
      mejorPuntaje = Math.max(mejorPuntaje, valores[0]);
    }
  }

  return mejorPuntaje;
}

// Flor: las 3 cartas son del mismo palo (modo opcional, desactivado en el MVP)
function tieneFlor(mano) {
  const porPalo = {};
  for (const carta of mano) {
    porPalo[carta.palo] = (porPalo[carta.palo] || 0) + 1;
  }
  return Object.values(porPalo).some((cant) => cant === 3);
}

module.exports = { calcular, tieneFlor };
