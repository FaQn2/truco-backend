// ============================================================
// Nombre: constants.js
// Rol: Tabla fija de jerarquías del Truco y utilidades de cartas
// Puerto de: scripts/utils/constants.gd (misma tabla, sin las
//            funciones de textura que son cosa del cliente Godot)
// Fuente de verdad: docs/Reglas_Truco_Argentino.md (sección 2 y 3)
// ============================================================

const PALOS = ['espada', 'basto', 'oro', 'copa'];
const VALORES = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12];

// Jerarquía del 1 (más débil) al 14 (más fuerte). NUNCA cambiar sin
// consultar docs/Reglas_Truco_Argentino.md — es una tabla cultural,
// no calculable.
const JERARQUIA_TRUCO = {
  espada_1: 14, // El Macho
  basto_1: 13, // La Hembra
  espada_7: 12, // El Siete Bravo
  oro_7: 11,
  espada_3: 10, basto_3: 10, oro_3: 10, copa_3: 10,
  espada_2: 9, basto_2: 9, oro_2: 9, copa_2: 9,
  copa_1: 8, oro_1: 8, // Anchos falsos
  espada_12: 7, basto_12: 7, oro_12: 7, copa_12: 7, // Reyes
  espada_11: 6, basto_11: 6, oro_11: 6, copa_11: 6, // Caballos
  espada_10: 5, basto_10: 5, oro_10: 5, copa_10: 5, // Sotas
  copa_7: 4, basto_7: 4, // Sietes falsos
  espada_6: 3, basto_6: 3, oro_6: 3, copa_6: 3,
  espada_5: 2, basto_5: 2, oro_5: 2, copa_5: 2,
  espada_4: 1, basto_4: 1, oro_4: 1, copa_4: 1,
};

function getJerarquia(palo, valor) {
  const clave = `${palo}_${valor}`;
  return JERARQUIA_TRUCO[clave] ?? 0;
}

// Las figuras (Sota=10, Caballo=11, Rey=12) valen 0 para el Envido
function esFigura(valor) {
  return valor >= 10;
}

function getValorEnvido(valor) {
  if (esFigura(valor)) return 0;
  return valor;
}

// Puntos por canto — docs/Reglas_Truco_Argentino.md sección 11
// Cada canto de la cadena de Envido suma su propio valor si se quiere
// (p.ej. Envido + Envido + Real Envido querido = 2 + 2 + 3 = 7).
// Falta Envido no suma: reemplaza todo por lo que le falta al líder (sección 6).
const PUNTOS_ENVIDO = {
  ENVIDO: 2,
  REAL_ENVIDO: 3,
};

const PUNTOS_TRUCO = {
  TRUCO: 2,
  RETRUCO: 3,
  VALE_CUATRO: 4,
};

const PUNTOS_NO_QUERIDO_TRUCO = {
  SIN_CANTO: 1,
  TRUCO: 1,
  RETRUCO: 2,
  VALE_CUATRO: 3,
};

// El Falta Envido vale lo que le falta al equipo que va GANANDO para llegar al objetivo
function calcularFaltaEnvido(ptsObjetivo, ptsLider) {
  return ptsObjetivo - ptsLider;
}

module.exports = {
  PALOS,
  VALORES,
  JERARQUIA_TRUCO,
  getJerarquia,
  esFigura,
  getValorEnvido,
  PUNTOS_ENVIDO,
  PUNTOS_TRUCO,
  PUNTOS_NO_QUERIDO_TRUCO,
  calcularFaltaEnvido,
};
