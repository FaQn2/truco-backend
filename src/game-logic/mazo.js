// ============================================================
// Nombre: mazo.js
// Rol: Representa el mazo de 40 cartas y maneja el barajado/reparto
// Puerto de: scripts/core/mazo.gd (mismo Fisher-Yates, mismas 40
//            cartas sin 08/09)
// ============================================================

const { PALOS, VALORES, getJerarquia, getValorEnvido, esFigura } = require('./constants');

class Mazo {
  constructor() {
    this._cartas = [];
    this._inicializarMazo();
  }

  // Recompone el mazo completo de 40 cartas y lo baraja. Como en el Truco
  // real, todas las cartas jugadas vuelven al mazo antes de cada mano nueva.
  barajar() {
    this._inicializarMazo();
    this._fisherYatesShuffle(this._cartas);
  }

  repartir(cantidad) {
    const mano = [];
    for (let i = 0; i < cantidad; i++) {
      if (this._cartas.length > 0) {
        mano.push(this._cartas.pop());
      }
    }
    return mano;
  }

  cartasRestantes() {
    return this._cartas.length;
  }

  _inicializarMazo() {
    this._cartas = [];
    for (const palo of PALOS) {
      for (const valor of VALORES) {
        this._cartas.push({
          valor,
          palo,
          id: `${palo}_${valor}`,
          jerarquia_truco: getJerarquia(palo, valor),
          valor_envido: getValorEnvido(valor),
          es_figura: esFigura(valor),
        });
      }
    }
  }

  _fisherYatesShuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = array[i];
      array[i] = array[j];
      array[j] = temp;
    }
  }
}

module.exports = Mazo;
