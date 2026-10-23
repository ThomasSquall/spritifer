# Spritifer

Editor di **pixel art e animazioni** che esporta **spritesheet** per videogiochi, con un **server MCP** che permette a Claude Code di disegnare personaggi, oggetti, tileset e ambienti pixel per pixel. Mentre Claude disegna, l'editor nel browser si aggiorna in tempo reale.

![workflow](docs/workflow.png)

## Avvio rapido

```bash
npm install
npm run build
```

Avvia l'editor web (sprite salvati in `./sprites`):

```bash
npm start
```

Poi apri http://localhost:7420.

## Far disegnare Claude Code

### In questo progetto

Il file `.mcp.json` registra già il server `spritifer`. Apri Claude Code in questa cartella, approva il server e chiedi ad esempio:

> Disegna un cavaliere 32×32 con palette sweetie16, con animazioni idle (2 frame) e walk (4 frame), poi esporta lo spritesheet.

### Nel progetto del tuo gioco

Dalla cartella del gioco, registra il server (gli sprite finiranno in `./sprites` del gioco):

```bash
node /percorso/di/Spritifer/dist/server/cli.js init
```

In alternativa, con la CLI di Claude Code:

```bash
claude mcp add spritifer -- node /percorso/di/Spritifer/dist/server/cli.js mcp --workspace ./sprites
```

Quando Claude Code avvia il server MCP, parte anche l'editor su http://localhost:7420 (se la porta è libera). Se hai già `npm start` in esecuzione, i due processi condividono gli stessi file e l'editor resta sincronizzato.

## Strumenti MCP

| Categoria | Strumenti |
| --- | --- |
| Sprite | `list_sprites`, `create_sprite`, `get_sprite`, `duplicate_sprite`, `delete_sprite`, `set_palette`, `resize_canvas` |
| Livelli | `add_layer`, `update_layer`, `delete_layer`, `merge_layer_down` |
| Animazione | `add_frames` (con `copy_from`), `delete_frames`, `move_frame`, `set_frame_duration`, `set_tag`, `delete_tag` |
| Disegno | `draw_pixels` (griglia di caratteri + legenda), `set_pixels`, `draw_line`, `draw_rect`, `draw_ellipse`, `fill`, `replace_color`, `clear`, `outline`, `mirror`, `transform` (shift/flip/rotate), `copy_region` |
| Verifica | `preview` (PNG ingrandito che Claude può vedere), `read_pixels` (griglia testuale) |
| Export/import | `export_spritesheet` (PNG + JSON), `import_png` |
| Altro | `undo`, `editor_url` |

`draw_pixels` è lo strumento principale: Claude scrive righe di caratteri e una legenda colore, ad esempio:

```json
{
  "sprite": "slime",
  "x": 4, "y": 6,
  "rows": [".kkkk.", "kggggk", "kgwgwk", "kggggk", ".kkkk."],
  "legend": { "k": "#181425", "g": "#63c74d", "w": "#ffffff" }
}
```

I colori si indicano come `#rrggbb`, `#rrggbbaa`, `transparent` o indice di palette (`p3`). I caratteri `.` e spazio non presenti nella legenda lasciano i pixel invariati.

### Ambienti e tileset

1. `create_sprite` con `tile_width`/`tile_height` (es. tileset 64×64 con tile 16×16).
2. Disegna ogni tile con `draw_pixels` usando il parametro `tile: {col, row}`.
3. Crea la scena su un canvas più grande e componila con `copy_region` (`source_sprite` = tileset, `source_tile`, più `targets`). Usa livelli separati per cielo, terreno e oggetti.

## Editor

- Strumenti: matita (B), gomma (E), riempimento (G), contagocce (I), linea (L), rettangolo (R), ellisse (O), sposta (M). Click sinistro/destro = colore primario/secondario, Alt+click = preleva colore.
- Simmetria orizzontale, griglia pixel e griglia tile, onion skin, zoom con rotellina, pan con Spazio+trascina.
- Livelli con visibilità, opacità, unione; palette con preset (PICO-8, Sweetie 16, DB16, Endesga 32, Game Boy).
- Timeline con miniature, durata per frame, tag di animazione (forward/reverse/pingpong), anteprima animata.
- Annulla/ripeti (anche le modifiche fatte da Claude), salvataggio automatico.
- Import di PNG e spritesheet esistenti (con taglio in frame).

## Export

`export_spritesheet` (o il pulsante **Export**) produce:

- `nome.png` con layout orizzontale, verticale, griglia, o una riga per tag; padding, margine e scala intera configurabili;
- `nome.json` in formato **Aseprite (array)**: rettangoli dei frame, durate e `frameTags`. È letto direttamente da Phaser (`load.aseprite`), Godot (importer Aseprite), Unity e LibGDX.

Esempio Phaser:

```js
this.load.aseprite('hero', 'sprites/export/hero.png', 'sprites/export/hero.json');
// ...
this.anims.createFromAseprite('hero');
this.add.sprite(100, 100, 'hero').play({ key: 'walk', repeat: -1 });
```

## Formato dei file

Ogni sprite è un file `sprites/<nome>.sprite.json` con dimensioni, palette, livelli, frame, tag, griglia tile opzionale e pixel RGBA (base64) per ogni cel `livello/frame`. L'editor e il server MCP leggono e scrivono gli stessi file; un watcher notifica le modifiche al browser via WebSocket.

## Sviluppo

```bash
npm test            # test di core, server MCP e API HTTP
npm run typecheck
npm run dev:web     # Vite con hot reload (richiede `npm start` per l'API)
```

Struttura:

- `src/core` — modello dello sprite, algoritmi di disegno, layout degli spritesheet (condiviso tra browser e Node)
- `src/server` — workspace su disco, codec PNG, server HTTP + WebSocket, server MCP, CLI
- `src/web` — editor nel browser (TypeScript senza framework)
