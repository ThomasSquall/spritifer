# Proposte di nuove funzionalità

Studio fatto dopo il passaggio ai **componenti per file** (classi `Behaviour` stile Unity, cartelle, parametri da inspector, `getComponent`, autocompletamento). Confronto con ciò che Unity, Godot e GameMaker danno per i giochi 2D che Spritifer punta a fare (platform, top-down, RPG), tenendo conto di come è fatto il motore (deterministico, headless per i playtest di Claude, export in un solo HTML).

## Già aggiunto con questo lavoro

Oltre a quanto richiesto (un behaviour per file, cartelle, ciclo di vita, parametri da inspector, autocompletamento, `getComponent`):

- **Componenti di scena e globali**: manager di livello (`Battle`, `WaveSpawner`) e componenti che vivono tra le scene (`GameManager`, inventario, HUD) con `onSceneStart` / `onSceneEnd`. Equivalgono al GameObject vuoto con `DontDestroyOnLoad` di Unity o agli *autoload* di Godot.
- **Override per istanza e componenti solo-istanza**, come i prefab override di Unity: campo vuoto = valore del tipo.
- **`addComponent` / `removeComponent` / `enabled`** a runtime, con `onEnable` / `onDisable`.
- **`sendMessage`, `findComponent(s)`**, campi statici condivisi (`GameManager.instance`).
- **Coroutine legate al componente** (`this.wait`, `this.waitUntil`, `this.every`), che si fermano da sole quando il componente viene distrutto.
- **Moduli** (`import` / `export`) per dati e funzioni condivise.
- **Stato dei componenti ricordato** nelle scene con memoria (lo scrigno resta aperto dopo la battaglia).
- **Azione evento "Call component method"**: eventi e componenti lavorano insieme.
- **Rinomina sicura**: rinominare o spostare un file componente aggiorna classe, oggetti, istanze, scene, gioco ed eventi.
- **`spritifer.d.ts` + `jsconfig.json` generati**: autocompletamento anche in VS Code e JetBrains, con i tipi restituiti da `getComponent('Nome')`.

## Fatto nel secondo giro

- **1. Libreria di componenti pronti**: Health, Damage, Shooter, Collectible, Door, Checkpoint, Respawn, Spawner, Countdown (`src/core/game/library.ts`). Si aggiungono dalla scheda Scripts (*Library*), da "+ Add component" o con gli strumenti MCP `component_library` / `add_library_component`.
- **2. Errori cliccabili con file e riga + hot reload** nel Play.
- **4. Event bus con dati**: `emit(name, data)`, `this.on(name, fn)`, `on(name, fn)`, `onMessage(name, data)`.
- **6. Tween ed easing**: `this.tween(...)`, `tween(...)`, `stopTweens(target)`.
- **7. (in parte) Transizioni**: `goto(scene, { fade })`, `restart({ fade })` e il campo *fade* nelle azioni evento. Zoom e dead-zone della camera restano da fare.
- **9. (in parte) Gamepad**: c'era già nel runtime (croce/stick, A, B, Start). Manca la mappatura configurabile delle azioni.

## Fatto nel terzo giro

- **3. Inspector dal vivo nel Play**: pausa, avanzamento di un frame, variabili, camera, componenti e istanze modificabili mentre il gioco gira (`src/core/game/debug.ts`, `src/web/playInspector.ts`).
- **5. Tag e query fisiche**: tag su tipi di oggetto e istanze, `hasTag`, `findWithTag`, `raycast`, `overlapBox`, `overlapCircle`, `findNearest`, `isSolidAt`, `countTag()` nelle espressioni.
- **8. Salvataggi a slot**: `saveGame` / `loadGame` / `hasSave` / `listSaves` / `deleteSave`, le azioni evento *Save game* / *Load game* e `hasSave()` nelle espressioni.

## Fatto nel quarto giro

- **7. Camera**: zoom, dead zone, look ahead, limiti per stanza (`camera.setBounds`) e `camera.follow`.
- **10. Pathfinding**: `findPath`, `self.pathTo`, `self.stopMoving`, più i componenti di libreria `Roam` e `ChasePath`.
- **11. Varianti di tipo**: `extends`, con ereditarietà di sprite, hitbox, proprietà, tag, componenti (override dei parametri) ed eventi; query e collisioni sul tipo padre includono le varianti.

Restano: mappatura delle azioni (9), musica e audio importato (12). Idee nuove: particelle, widget per l'interfaccia (pulsanti, liste), eventi legati ai frame delle animazioni.

## Prossimi passi consigliati (in ordine)

| # | Funzionalità | Perché | Sforzo |
|---|---|---|---|
| 1 | **Libreria di componenti pronti** (Health, Damage, Collectible, Door/Teleport, Checkpoint, Spawner, Follow, FlashOnHit, Shooter) inseribili con un clic da "+ Add component" | Chi inizia non parte da zero, e Claude ha mattoni affidabili da combinare. Sono file normali nella cartella del progetto, quindi si possono leggere e modificare. | Basso |
| 2 | **Errori cliccabili file:riga** (caricamento e runtime) che aprono lo script alla riga giusta, più **hot reload** degli script durante il Play | Oggi l'errore dice il componente e il metodo ma non la riga. L'editor ha già `gotoLine`: serve leggere lo stack (V8 dà `scripts/x.js:12`). | Basso–medio |
| 3 | **Inspector live nel Play**: pausa, avanzamento di un frame, gerarchia delle istanze con i campi dei componenti modificabili mentre il gioco gira | È lo strumento di debug più usato in Unity. `fieldsOf()` e `snapshot()` danno già i dati. | Medio |
| 4 | **Event bus con dati**: `emit('playerHit', { damage: 2 })` e `onMessage(name, data)`, più `this.on('event', fn)` che si scollega da solo alla distruzione | Oggi i messaggi sono solo stringhe: per passare dati servono le variabili globali. | Basso |
| 5 | **Tag e query fisiche**: tag sui tipi di oggetto (`enemy`, `pickup`), `self.hasTag()`, `findWithTag()`, `overlapBox()`, `raycast()`, `isSolidAt(x, y)` | Permettono IA e meccaniche (vista del nemico, attacco ad area) senza scorrere tutte le istanze a mano. | Medio |
| 6 | **Tween ed easing**: `await this.tween(this.self, { x: 120, opacity: 0 }, 0.4, 'outQuad')` | Animazioni di UI, camera, oggetti che cadono o porte che si aprono, in una riga. Si integra con le coroutine. | Basso |
| 7 | **Transizioni e camera**: `goto('dungeon', { fade: 0.4 })`, zoom, dead-zone del follow, limiti della camera per stanza | Rifinitura subito visibile in RPG e metroidvania. | Basso–medio |
| 8 | **Salvataggi a slot**: `saveGame(slot)` / `loadGame(slot)` con variabili, scena corrente, memoria delle scene e campi dei componenti | Gli RPG lo richiedono. La memoria delle scene esiste già: va solo serializzata. | Medio |
| 9 | **Input mapping e gamepad**: azioni con nome (`jump`, `attack`) associate a tasti e pulsanti del gamepad, configurabili dalla pagina Game | Serve per giocare con il controller e per avere comandi coerenti tra un gioco e l'altro. | Medio |
| 10 | **Pathfinding su tilemap** (A* sui layer solid): `await this.self.pathTo(x, y)` | NPC che camminano per il villaggio e nemici che inseguono aggirando i muri. | Medio |
| 11 | **Varianti di tipo** (prefab variant): un tipo di oggetto che eredita da un altro e cambia solo alcuni componenti o parametri | Slime verde / rosso / boss senza duplicare tutto. | Medio |
| 12 | **Musica e audio importato**: musica per scena con crossfade, file audio caricati oltre ai suoni sintetici | Oggi ci sono solo effetti sintetizzati. | Medio |

## Note di progetto

- Le funzionalità 1, 4 e 6 sono solo API e file, quindi l'MCP di Claude le guadagna gratis: `script_reference` e la `d.ts` vengono generate dallo stesso catalogo (`src/core/game/scriptApi.ts`), che resta l'unica fonte.
- Le funzionalità 3 e 9 toccano il runtime del browser (`src/runtime`), mentre il motore resta deterministico, così i playtest headless continuano a funzionare.
- Per la 2, l'evaluator `node:vm` e `new Function(... //# sourceURL=scripts/x.js)` producono già stack con file e riga: basta estrarli in `ScriptHost.report()`.
