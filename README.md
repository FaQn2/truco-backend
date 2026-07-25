# Backend — Truco Argentino Online

Servidor autoritario Node.js + WebSockets. **Fase 2, Etapa 1**: corre en
`localhost`, todavía no hay deploy a un hosting real (eso es la Etapa 2,
ver `docs/FASE_2_MULTIPLAYER_PLAN.md`).

El servidor nunca confía en el cliente: valida cada jugada, y cada jugador
recibe únicamente sus propias cartas (nunca las del rival, ni siquiera en
el JSON de la sala).

## Instalación

```bash
cd backend
npm install
```

## Correr el servidor

```bash
npm start
# o directamente:
node server.js
```

Por defecto escucha en `ws://localhost:3000`. Para usar otro puerto:

```bash
# PowerShell
$env:PORT = 4000; node server.js

# bash
PORT=4000 node server.js
```

## Probar el backend aislado (sin Godot)

`test-client.js` simula DOS clientes con el protocolo WebSocket real: uno
crea una sala, el otro se une con el código, y juegan una mano completa
automáticamente (tiran la primera carta de su mano en cada turno, sin
cantar Envido/Truco). Todo se imprime por consola — sirve para confirmar
que la lógica de salas + reglas del Truco funciona antes de meter la
complejidad del cliente 3D.

**Con el servidor corriendo en otra terminal:**

```bash
node test-client.js
```

Si usaste un puerto distinto de 3000 para el servidor, pasale el mismo acá:

```bash
PORT=4000 node test-client.js
```

Salida esperada: los dos clientes (`[A]` y `[B]`) se conectan, reparten
mano, tiran cartas, resuelven rondas, y al final se ve
`✅ Test OK: se jugó una mano completa de punta a punta.`

## Estructura

```
backend/
├── server.js                        ← punto de entrada, levanta el WebSocketServer
├── src/
│   ├── game-logic/                  ← puerto 1:1 de scripts/core/*.gd a JS
│   │   ├── constants.js
│   │   ├── mazo.js
│   │   ├── state_machine.js
│   │   ├── calculador_envido.js
│   │   ├── validador_cantos.js
│   │   └── partida.js               ← orquestador de una mano/partida (equivalente
│   │                                   servidor de game_manager.gd, pero para 2
│   │                                   jugadores humanos en vez de Jugador vs IA)
│   └── socket-handlers/
│       ├── room-manager.js          ← crear/unirse a salas, código de 4 caracteres
│       └── connection-handler.js    ← parsea mensajes JSON y despacha acciones
└── test-client.js
```

## Protocolo (mensajes JSON sobre WebSocket)

### Cliente → Servidor

| type | campos | notas |
|---|---|---|
| `CREAR_SALA` | `nombreSala`, `modo` (`1v1`\|`2v2`), `nombre`, `puntosObjetivo?` | crea una sala nueva y sienta al creador en el asiento 0, responde `SALA_CREADA` + `DETALLE_SALA` |
| `LISTAR_SALAS` | `modo?` | pide el buscador de salas abiertas (no llenas, no en juego), responde `LISTA_SALAS` |
| `VER_SALA` | `code` | abre el panel de detalle en vivo de una sala (te suscribe a sus actualizaciones), responde `DETALLE_SALA` |
| `ELEGIR_ASIENTO` | `code`, `asiento` (índice), `nombre` | ocupa un asiento libre de la sala; si la sala es 1v1 y queda llena, arranca la partida | 
| `DEJAR_ASIENTO` | `code` | libera el asiento propio sin salir de la sala |
| `SALIR_SALA` | — | deja de ver/ocupar la sala actual (botón "Volver") |
| `JUGAR_CARTA` | `cardId` | tira una carta de la propia mano |
| `CANTAR_ENVIDO` | `tipo` (`ENVIDO`\|`REAL_ENVIDO`\|`FALTA_ENVIDO`) | abre la cadena de Envido |
| `ESCALAR_ENVIDO` | `tipo` | sube una cadena de Envido ya abierta |
| `RESPONDER_ENVIDO` | `quiero` (bool) | responde Quiero/No Quiero al Envido |
| `CANTAR_TRUCO` | — | primer canto de Truco de la mano |
| `SUBIR_TRUCO` | — | sube Truco→Retruco→Vale Cuatro (solo quien tiene el "quiero") |
| `RESPONDER_TRUCO` | `quiero` (bool), `subir?` (bool) | responde al Truco, opcionalmente subiendo |
| `IRSE_AL_MAZO` | — | se va al mazo |
| `DECLARAR_ENVIDO` | — | **solo 2v2**: declara tu puntaje real de Envido en la fase de declaración en cadena (el servidor lo calcula, no confía en ningún número del cliente); falla si no supera el mejor anunciado |
| `SON_BUENAS` | — | **solo 2v2**: pasa tu turno de declaración sin declarar nada |

### Servidor → Cliente

`SALA_CREADA`, `LISTA_SALAS`, `DETALLE_SALA` (foto del estado de una sala:
`code`, `nombreSala`, `modo`, `capacidad`, `estado` — `esperando`/`completa`/
`jugando` —, `asientos: [{index, ocupado, nombre}]`; se manda una vez al
pedir `VER_SALA`/`ELEGIR_ASIENTO` y de nuevo cada vez que cambia mientras la
estés viendo), `ASIENTO_CONFIRMADO` (`code`, `asiento` — respuesta directa a
quien pidió `ELEGIR_ASIENTO`, así sabe cuál asiento es el suyo dentro del
snapshot genérico de `DETALLE_SALA`), `PARTIDA_INICIADA`, `MANO_REPARTIDA`
(solo tu propia mano), `TURNO_CAMBIADO`, `CARTA_JUGADA`, `RONDA_RESUELTA`,
`MANO_TERMINADA`, `PARTIDA_TERMINADA`, `PUNTOS_ACTUALIZADOS`,
`CANTO_REALIZADO`, `ESTADO_CAMBIADO`, `ENVIDO_TERMINADO` (revela puntajes,
nunca las cartas del rival), `ERROR`.

El asiento (`seat`, índice `0..capacidad-1`) que confirma el servidor en
`ASIENTO_CONFIRMADO` es tu identidad para toda la partida — el servidor lo
usa para validar cada acción, así que nunca hace falta (ni sirve) mandar un
id de jugador en los mensajes de juego.

`PARTIDA_INICIADA` (y todo el protocolo de juego que sigue) se dispara para
salas en modo `1v1` (motor `partida.js`, sin cambios) y, si está habilitado
(ver abajo), `2v2` (motor nuevo `partida_equipos.js`, 4 asientos en 2
equipos — `equipo = asiento % 2`, compañeros siempre enfrentados).
`PARTIDA_INICIADA` lleva un campo `modo` para que el cliente sepa a cuál de
los dos motores está entrando.

**2v2 todavía no arranca solo en producción.** El motor ya está probado
(`test-client-2v2.js`), pero el cliente Godot todavía no tiene la escena 3D
de 4 asientos — una sala 2v2 que se llena queda en `estado: 'completa'` (no
`'jugando'`) hasta que se saque el modo de `MODOS_QUE_ARRANCAN_SOLOS` en
`room-manager.js`. Para seguir probando el motor por consola mientras tanto:

```bash
# PowerShell
$env:HABILITAR_2V2 = '1'; node server.js

# bash
HABILITAR_2V2=1 node server.js
```

### Diferencias del protocolo en modo 2v2

- `MANO_REPARTIDA` lleva además `manoCompanero` (la mano del compañero —
  nunca la del equipo rival; sección 17: hay que poder verla sí o sí).
- `RONDA_RESUELTA`, `MANO_TERMINADA`, `PARTIDA_TERMINADA` y
  `ENVIDO_TERMINADO` usan `ganadorEquipo` (0 o 1) en vez de `ganador`
  (asiento) — los puntos son del equipo, no del jugador.
- `PUNTOS_ACTUALIZADOS` lleva `puntosEquipoA`/`puntosEquipoB` en vez de
  `puntosJ1`/`puntosJ2`.
- Después de un `RESPONDER_ENVIDO {quiero: true}` no se resuelve directo
  como en 1v1: arranca una fase de declaración en cadena (sección 17) — el
  servidor manda `ENVIDO_DECLARACION_TURNO {asiento}` indicando a quién le
  toca, ese jugador manda `DECLARAR_ENVIDO` (su puntaje real, calculado por
  el servidor) o `SON_BUENAS`, el servidor confirma con
  `ENVIDO_DECLARADO {asiento, valor}` (`valor: null` = son buenas) y repite
  hasta que hablaron los 4 (o los que sigan en pie), y recién ahí llega
  `ENVIDO_TERMINADO` con el objeto `declaraciones` completo.
- `RESPONDER_TRUCO` lo puede mandar cualquiera de los 2 asientos del equipo
  que debe responder (no hace falta que sea "su turno") — el primero que
  responde cierra la decisión para los 2.
