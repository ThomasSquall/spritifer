/**
 * Ready-made components. Adding one copies its file into the project's scripts/ folder: it is a normal
 * script you can read and change. (Sources avoid template literals so they can live in this file.)
 */

export interface LibraryComponent {
  name: string;
  /** Folder in scripts/ where it is created. */
  folder: string;
  summary: string;
  /** Other library components it works with (created too when missing). */
  requires?: string[];
  /** How to use it, shown before adding. */
  usage: string;
  code: string;
}

const HEALTH = `/**
 * Hit points. Others call getComponent('Health').damage(n). It tells the other components of the
 * instance with onHurt(amount, from) and onDeath(from), and emits "died" with { object, name, sceneId }.
 */
export default class Health extends Behaviour {
  max = 3
  invincibleTime = 0.6
  destroyOnDeath = true
  hpVariable = ''
  hurtSound = 'hurt'
  deathSound = 'explosion'
  showBar = false
  barColor = '#e43b44'

  static params = {
    max: { min: 1, step: 1, help: 'Hit points' },
    invincibleTime: { min: 0, step: 0.1, help: 'Seconds without damage after a hit (the instance blinks)' },
    destroyOnDeath: { help: 'Turn off for the player (use Respawn)' },
    hpVariable: { help: 'Keep the HP in this global variable (e.g. hp): it then survives scene changes' },
    hurtSound: 'sound',
    deathSound: 'sound',
    showBar: { help: 'Draw a small HP bar above the instance' },
  }

  _hp = 0
  _safeUntil = 0

  awake() {
    if (this.hpVariable && Number(vars[this.hpVariable]) > 0) this._hp = Math.min(this.max, Number(vars[this.hpVariable]))
    else this._set(this.max)
  }

  get hp() {
    return this._hp
  }

  get dead() {
    return this._hp <= 0
  }

  /** Returns true when the hit landed (not invincible, not already dead). */
  damage(amount = 1, from = null) {
    if (this._hp <= 0 || game.clock < this._safeUntil || !this.enabled) return false
    this._set(this._hp - amount)
    this._safeUntil = game.clock + this.invincibleTime
    if (this.invincibleTime > 0) this.self.flash(this.invincibleTime)
    this.self.sendMessage('onHurt', amount, from)
    if (this._hp > 0) {
      if (this.hurtSound) sound(this.hurtSound)
      return true
    }
    if (this.deathSound) sound(this.deathSound)
    this.self.sendMessage('onDeath', from)
    this.emit('died', { object: this.self.object, name: this.self.name, sceneId: this.self.sceneId })
    if (this.destroyOnDeath) this.self.destroy()
    return true
  }

  heal(amount = 1) {
    if (this._hp > 0) this._set(this._hp + amount)
  }

  /** Full health again (and briefly invincible). */
  revive() {
    this._set(this.max)
    this._safeUntil = game.clock + this.invincibleTime
  }

  _set(v) {
    this._hp = Math.max(0, Math.min(this.max, v))
    if (this.hpVariable) vars[this.hpVariable] = this._hp
  }

  /** @param {Ui} ui */
  onDraw(ui) {
    if (!this.showBar || this._hp <= 0) return
    const p = ui.toScreen(this.self.centerX - 8, this.self.y - 5)
    ui.bar(p.x, p.y, 16, 4, this._hp, this.max, this.barColor)
  }
}
`;

const DAMAGE = `/**
 * Hurts what it touches: spikes, enemies, bullets. Calls damage() on the other's Health component.
 */
export default class Damage extends Behaviour {
  amount = 1
  target = 'player'
  continuous = true
  knockback = 140
  destroyOnHit = false

  static params = {
    amount: { min: 1, step: 1 },
    target: { type: 'object', help: 'Object type it hurts (empty = anything with Health)' },
    continuous: { help: 'Keep hurting while touching (each time the invincibility ends)' },
    knockback: { min: 0, help: 'Push away speed in px/s (best on platformers)' },
    destroyOnHit: { help: 'Bullets: disappear after hitting' },
  }

  /** @param {Instance} other */
  onCollisionEnter(other) {
    this._hit(other)
  }

  /** @param {Instance} other */
  onCollisionStay(other) {
    if (this.continuous) this._hit(other)
  }

  _hit(other) {
    if (this.target && other.object !== this.target) return
    const health = other.getComponent('Health')
    if (!health || !health.damage(this.amount, this.self)) return
    if (this.knockback) {
      const dx = other.centerX - this.self.centerX
      other.vx = (dx < 0 ? -1 : 1) * this.knockback
      other.vy = -this.knockback * 0.8
    }
    if (this.destroyOnHit) this.self.destroy()
  }
}
`;

const COLLECTIBLE = `/**
 * A pickup (coin, gem, heart): adds to a global variable when the collector touches it, then pops away.
 * Emits "collected" with { variable, amount, object }.
 */
export default class Collectible extends Behaviour {
  variable = 'score'
  amount = 1
  heal = 0
  collector = 'player'
  pickupSound = 'coin'

  static params = {
    variable: { help: 'Global variable to increase (empty = none)' },
    heal: { min: 0, step: 1, help: 'Also heals the collector (needs Health)' },
    collector: { type: 'object', help: 'Who can pick it up (empty = anyone)' },
    pickupSound: 'sound',
  }

  _taken = false

  /** @param {Instance} other */
  async onCollisionEnter(other) {
    if (this._taken || (this.collector && other.object !== this.collector)) return
    this._taken = true
    if (this.variable) vars[this.variable] = (Number(vars[this.variable]) || 0) + this.amount
    if (this.heal) other.getComponent('Health')?.heal(this.heal)
    if (this.pickupSound) sound(this.pickupSound)
    this.emit('collected', { variable: this.variable, amount: this.amount, object: this.self.object })
    await this.tween(this.self, { y: this.self.y - 10, opacity: 0 }, 0.25, 'outQuad')
    this.self.destroy()
  }
}
`;

const DOOR = `/**
 * Takes the player to another scene, or to another door of this one. You arrive at the door whose
 * instance Name is \`entry\`, moved by dx, dy tiles. Name the doors in the scene inspector.
 */
export default class Door extends Behaviour {
  scene = ''
  entry = ''
  dx = 0
  dy = 0
  requireAction = false
  fade = 0.3
  doorSound = 'step'

  static params = {
    scene: { type: 'scene', help: 'Where it leads (empty = this scene)' },
    entry: { help: 'Name of the door you arrive at' },
    dx: { step: 1, help: 'When you ARRIVE at this door: offset in tiles' },
    dy: { step: 1 },
    requireAction: { help: 'Press action to use it instead of just touching it' },
    fade: { min: 0, step: 0.1, help: 'Fade to black (seconds)' },
    doorSound: 'sound',
  }

  // True while the player stands on this door since arriving: it only works again after stepping off.
  _blocked = false

  start() {
    // Arriving here from another door?
    if (vars.__door && vars.__door === this.self.name) {
      vars.__door = ''
      this.place(player())
    }
    const p = player()
    this._blocked = !!p && this.self.overlaps(p)
  }

  /** Puts an instance on this door (feet on the door, moved by dx, dy tiles) facing away from it. */
  place(p) {
    if (!p) return
    const ts = scene.tileSize
    p.x += this.self.centerX + this.dx * ts - p.centerX
    p.y += this.self.y + this.self.height + this.dy * ts - (p.centerY + p.height / 2)
    p.vx = 0
    p.vy = 0
    if (this.dx || this.dy) p.face(this.dy < 0 ? 'up' : this.dy > 0 ? 'down' : this.dx < 0 ? 'left' : 'right')
  }

  /** @param {Instance} other */
  onCollisionEnter(other) {
    if (!this.requireAction && other === player() && !this._blocked) this.use()
  }

  /** @param {Instance} other */
  onCollisionExit(other) {
    if (other === player()) this._blocked = false
  }

  /** @param {Instance} p */
  onInteract(p) {
    if (this.requireAction) this.use()
  }

  use() {
    if (this.doorSound) sound(this.doorSound)
    if (this.scene && this.scene !== scene.name) {
      vars.__door = this.entry
      goto(this.scene, { fade: this.fade })
      return
    }
    const target = findComponents('Door').find((d) => d.self && d.self.name === this.entry)
    const p = player()
    if (target && p) {
      target.place(p)
      target._blocked = target.self.overlaps(p)
    }
  }
}
`;

const CHECKPOINT = `/**
 * Touching it makes it the player's respawn point (see Respawn). Plays its "active" animation if the
 * sprite has one. Emits "checkpoint" with { scene, name }.
 */
export default class Checkpoint extends Behaviour {
  activeAnimation = 'active'
  checkpointSound = 'powerup'

  static params = {
    activeAnimation: { help: 'Animation tag to play once reached (if the sprite has it)' },
    checkpointSound: 'sound',
  }

  start() {
    if (this.isCurrent()) this._show()
  }

  isCurrent() {
    return vars.__checkpoint === scene.name + '|' + this.self.sceneId
  }

  /** @param {Instance} other */
  onCollisionEnter(other) {
    if (other !== player() || this.isCurrent()) return
    vars.__checkpoint = scene.name + '|' + this.self.sceneId
    vars.__checkpointX = this.self.centerX
    vars.__checkpointY = this.self.y + this.self.height
    if (this.checkpointSound) sound(this.checkpointSound)
    this._show()
    this.emit('checkpoint', { scene: scene.name, name: this.self.name })
  }

  _show() {
    if (this.activeAnimation && this.self.has(this.activeAnimation)) this.self.play(this.activeAnimation)
  }
}
`;

const RESPAWN = `/**
 * On the player, with Health: at 0 HP the player comes back at the last Checkpoint (or where the scene
 * started) with full health. Optional lives and a game over scene.
 */
export default class Respawn extends Behaviour {
  delay = 0.6
  fade = 0.3
  restartScene = false
  livesVariable = ''
  gameOverScene = ''

  static params = {
    delay: { min: 0, step: 0.1, help: 'Seconds before coming back' },
    fade: { min: 0, step: 0.1 },
    restartScene: { help: 'Restart the whole scene instead of moving to the checkpoint' },
    livesVariable: { help: 'Global variable with the lives left (empty = infinite)' },
    gameOverScene: { type: 'scene', help: 'Where to go when the lives run out' },
  }

  _startX = 0
  _startY = 0

  awake() {
    const health = this.getComponent('Health')
    if (health) health.destroyOnDeath = false
    this._startX = this.self.centerX
    this._startY = this.self.centerY + this.self.height / 2
    // Coming back to the checkpoint's scene: start there.
    if (String(vars.__checkpoint || '').startsWith(scene.name + '|')) this._moveTo(vars.__checkpointX, vars.__checkpointY)
  }

  async onDeath() {
    lockControls(true)
    await this.wait(this.delay)
    lockControls(false)
    if (this.livesVariable) {
      vars[this.livesVariable] = (Number(vars[this.livesVariable]) || 0) - 1
      if (vars[this.livesVariable] <= 0 && this.gameOverScene) {
        goto(this.gameOverScene, { fade: this.fade })
        return
      }
    }
    if (this.restartScene) {
      restart({ fade: this.fade })
      return
    }
    const cp = String(vars.__checkpoint || '')
    const cpScene = cp.split('|')[0]
    if (cpScene && cpScene !== scene.name) {
      goto(cpScene, { fade: this.fade })
      return
    }
    if (cpScene) this._moveTo(vars.__checkpointX, vars.__checkpointY)
    else this._moveTo(this._startX, this._startY)
    this.self.vx = 0
    this.self.vy = 0
    this.getComponent('Health')?.revive()
  }

  _moveTo(cx, bottom) {
    this.self.x += cx - this.self.centerX
    this.self.y += bottom - (this.self.centerY + this.self.height / 2)
  }
}
`;

const SPAWNER = `/**
 * Creates instances of an object every few seconds, up to a maximum alive at once. Put it on an
 * (invisible) object where things should appear, or on a scene (then offsetX/offsetY are the position).
 * Emits "spawned" with { object }.
 */
export default class Spawner extends Behaviour {
  object = ''
  interval = 2
  maxAlive = 3
  spawnAtStart = true
  offsetX = 0
  offsetY = 0
  randomX = 0
  randomY = 0

  static params = {
    object: 'object',
    interval: { min: 0.1, step: 0.1, help: 'Seconds between spawns' },
    maxAlive: { min: 1, step: 1 },
    randomX: { min: 0, help: 'Random spread in pixels' },
    randomY: { min: 0 },
  }

  _alive = []

  start() {
    if (this.spawnAtStart) this.spawn()
    this.every(this.interval, () => this.spawn())
  }

  spawn() {
    if (!this.object) return null
    this._alive = this._alive.filter((h) => h.alive)
    if (this._alive.length >= this.maxAlive) return null
    const base = this.self || { x: 0, y: 0 }
    const x = base.x + this.offsetX + random(-this.randomX, this.randomX)
    const y = base.y + this.offsetY + random(-this.randomY, this.randomY)
    const h = spawn(this.object, Math.round(x), Math.round(y))
    if (h) {
      this._alive.push(h)
      this.emit('spawned', { object: this.object })
    }
    return h
  }
}
`;

const SHOOTER = `/**
 * Fires an object (a bullet: give it the Bullet behavior and Damage with destroyOnHit) when a key is
 * pressed, or by itself toward the nearest target (turrets, enemies).
 */
export default class Shooter extends Behaviour {
  bullet = ''
  speed = 180
  cooldown = 0.3
  key = 'action2'
  aim = 'flip'
  auto = false
  target = 'player'
  range = 160
  shootSound = 'laser'
  offsetY = 0

  static params = {
    bullet: 'object',
    cooldown: { min: 0, step: 0.05, help: 'Seconds between shots' },
    key: 'key',
    aim: { options: ['flip', 'facing', 'target'], help: 'flip: left/right like a platformer; facing: 4 directions (top-down); target: toward the nearest target' },
    auto: { help: 'Shoot by itself when a target is in range' },
    target: { type: 'object', help: 'What auto mode / target aim shoots at' },
    range: { min: 0 },
    shootSound: 'sound',
  }

  _next = 0

  update() {
    if (game.clock < this._next) return
    if (this.auto ? !!this.nearestTarget() : pressed(this.key)) this.fire()
  }

  nearestTarget() {
    let best = null
    let bestD = this.range
    for (const o of find(this.target)) {
      const d = this.self.distanceTo(o)
      if (d <= bestD) {
        bestD = d
        best = o
      }
    }
    return best
  }

  fire() {
    if (!this.bullet) return null
    const s = this.self
    let dx = s.flipX ? -1 : 1
    let dy = 0
    const t = this.aim === 'target' || this.auto ? this.nearestTarget() : null
    if (t) {
      dx = t.centerX - s.centerX
      dy = t.centerY - s.centerY
    } else if (this.aim === 'facing') {
      dx = s.facing === 'left' ? -1 : s.facing === 'right' ? 1 : 0
      dy = s.facing === 'up' ? -1 : s.facing === 'down' ? 1 : 0
    }
    const d = Math.hypot(dx, dy) || 1
    const b = spawn(this.bullet, s.centerX, s.centerY + this.offsetY)
    if (!b) return null
    b.x -= b.width / 2
    b.y -= b.height / 2
    b.vx = (dx / d) * this.speed
    b.vy = (dy / d) * this.speed
    b.flipX = b.vx < 0
    this._next = game.clock + this.cooldown
    if (this.shootSound) sound(this.shootSound)
    return b
  }
}
`;

const COUNTDOWN = `/**
 * A level timer (put it on a scene): counts a global variable down to 0, shows it, then restarts the
 * scene, goes to another one or emits a message.
 */
export default class Countdown extends Behaviour {
  seconds = 60
  variable = 'timeLeft'
  whenDone = 'restart'
  scene = ''
  message = 'timeUp'
  show = true
  color = '#ffffff'

  static params = {
    seconds: { min: 1, step: 1 },
    variable: { help: 'Global variable holding the seconds left' },
    whenDone: ['restart', 'goto scene', 'emit message', 'nothing'],
    scene: { type: 'scene', help: 'For "goto scene"' },
    message: { help: 'For "emit message"' },
    show: { help: 'Draw the time at the top center' },
  }

  _left = 0
  _done = false

  start() {
    this._left = this.seconds
    vars[this.variable] = this.seconds
  }

  update(dt) {
    if (this._done) return
    this._left = Math.max(0, this._left - dt)
    vars[this.variable] = Math.ceil(this._left)
    if (this._left > 0) return
    this._done = true
    if (this.whenDone === 'restart') restart({ fade: 0.3 })
    else if (this.whenDone === 'goto scene' && this.scene) goto(this.scene, { fade: 0.3 })
    else if (this.whenDone === 'emit message') emit(this.message)
  }

  /** @param {Ui} ui */
  onDraw(ui) {
    if (!this.show) return
    ui.text(String(Math.ceil(this._left)), ui.width / 2, 4, { align: 'center', size: 2, color: this._left <= 10 ? '#e43b44' : this.color })
  }
}
`;

const ROAM = `/**
 * Walks to random reachable spots around where it started, around walls, pausing in between
 * (villagers, animals). Stops when the player talks to it and while dialogs are open.
 */
export default class Roam extends Behaviour {
  radius = 64
  speed = 30
  pauseMin = 1
  pauseMax = 3
  diagonal = false

  static params = {
    radius: { min: 0, help: 'How far from home it wanders (px)' },
    speed: { min: 1 },
    pauseMin: { min: 0, step: 0.5, help: 'Seconds standing still between walks' },
    pauseMax: { min: 0, step: 0.5 },
  }

  _homeX = 0
  _homeY = 0

  start() {
    this._homeX = this.self.centerX
    this._homeY = this.self.centerY
    this._loop()
  }

  async _loop() {
    for (;;) {
      await this.wait(random(this.pauseMin, Math.max(this.pauseMin, this.pauseMax)))
      await this.waitUntil(() => this.enabled && !game.dialogOpen)
      const x = this._homeX + random(-this.radius, this.radius)
      const y = this._homeY + random(-this.radius, this.radius)
      await this.self.pathTo(x, y, this.speed, { diagonal: this.diagonal })
    }
  }

  /** @param {Instance} player */
  onInteract(player) {
    this.self.stopMoving()
  }

  onDisable() {
    this.self.stopMoving()
  }
}
`;

const CHASE_PATH = `/**
 * Chases a target around walls (pathfinding) once it comes within range, and gives up when it gets
 * far enough away. Pair it with Damage to hurt on contact.
 */
export default class ChasePath extends Behaviour {
  target = 'player'
  range = 120
  giveUpRange = 220
  speed = 45
  repath = 0.4
  diagonal = true

  static params = {
    target: { type: 'object', help: 'What it chases (variants included)' },
    range: { min: 0, help: 'Starts chasing within this distance (px)' },
    giveUpRange: { min: 0, help: 'Stops chasing beyond this distance' },
    speed: { min: 1 },
    repath: { min: 0.1, step: 0.1, help: 'Seconds between path updates' },
  }

  _chasing = false

  start() {
    this.every(this.repath, () => this.think())
  }

  think() {
    if (game.dialogOpen) return
    const t = findNearest(this.self, { object: this.target })
    if (!t) return
    const d = this.self.distanceTo(t)
    if (!this._chasing && d > this.range) return
    if (this._chasing && d > this.giveUpRange) {
      this._chasing = false
      this.self.stopMoving()
      this.emit('lostTarget', { object: this.self.object })
      return
    }
    if (!this._chasing) this.emit('spotted', { object: this.self.object })
    this._chasing = true
    this.self.pathTo(t.centerX, t.centerY, this.speed, { diagonal: this.diagonal, maxSteps: 2 })
  }

  onDisable() {
    this._chasing = false
    this.self.stopMoving()
  }
}
`;

const PARTICLE_EMITTER = `/**
 * Emits particles continuously from the instance (or a scene position): dust trails, torches,
 * auras, smoke. With onlyWhenMoving it makes footstep dust.
 */
export default class ParticleEmitter extends Behaviour {
  preset = 'dust'
  rate = 10
  onlyWhenMoving = false
  offsetX = 0
  offsetY = 0
  behind = false

  static params = {
    preset: ['dust', 'sparks', 'hit', 'explosion', 'smoke', 'magic', 'leaves', 'splash', 'confetti', 'heal'],
    rate: { min: 0, help: 'Particles per second' },
    onlyWhenMoving: { help: 'Only while the instance moves (footstep dust)' },
    offsetX: { help: 'From the center of the instance (px); on a scene: the position' },
    offsetY: { help: 'From the bottom of the instance (px)' },
    behind: { help: 'Draw behind the instances' },
  }

  _acc = 0
  _lastX = 0
  _lastY = 0

  start() {
    if (this.self) {
      this._lastX = this.self.x
      this._lastY = this.self.y
    }
  }

  update(dt) {
    const s = this.self
    let moving = true
    if (s) {
      moving = Math.abs(s.x - this._lastX) + Math.abs(s.y - this._lastY) > 0.05
      this._lastX = s.x
      this._lastY = s.y
    }
    if (this.onlyWhenMoving && !moving) return
    this._acc += this.rate * dt
    const n = Math.floor(this._acc)
    if (n < 1) return
    this._acc -= n
    const x = s ? s.centerX + this.offsetX : this.offsetX
    const y = s ? s.y + s.height + this.offsetY : this.offsetY
    particles(x, y, this.preset, { count: n, behind: this.behind })
  }
}
`;

export const LIBRARY: LibraryComponent[] = [
  { name: 'Health', folder: 'combat', summary: 'Hit points with invincibility, sounds, death and an optional HP bar.', usage: 'Put it on the player and on enemies. Damage, bullets and scripts call getComponent("Health").damage(n).', code: HEALTH },
  { name: 'Damage', folder: 'combat', summary: 'Hurts what it touches (spikes, enemies, bullets), with knockback.', requires: ['Health'], usage: 'Put it on hazards and enemies; the victim needs Health. On bullets turn on destroyOnHit.', code: DAMAGE },
  { name: 'Shooter', folder: 'combat', summary: 'Fires bullets with a key or automatically at a target.', usage: 'Make a bullet object (Bullet behavior + Damage with destroyOnHit) and pick it as "bullet".', code: SHOOTER },
  { name: 'Collectible', folder: 'items', summary: 'Pickup: adds to a variable (score, coins), can heal, pops away.', usage: 'Put it on coins and gems; set the global variable it increases.', code: COLLECTIBLE },
  { name: 'Door', folder: 'world', summary: 'Goes to another scene or door, with fade and arrival point.', usage: 'Name each door instance; set scene + entry (the name of the door you arrive at).', code: DOOR },
  { name: 'Checkpoint', folder: 'world', summary: 'Touching it saves where the player respawns.', usage: 'Place it in levels; works with Respawn on the player.', code: CHECKPOINT },
  { name: 'Respawn', folder: 'player', summary: 'At 0 HP: back at the last checkpoint, with lives and game over.', requires: ['Health'], usage: 'Put it on the player together with Health.', code: RESPAWN },
  { name: 'Roam', folder: 'ai', summary: 'Wanders to random spots around its home, around walls, with pauses.', usage: 'Put it on villagers and animals (top-down). It stops while dialogs are open.', code: ROAM },
  { name: 'ChasePath', folder: 'ai', summary: 'Chases a target around walls with pathfinding; gives up when far.', usage: 'Put it on enemies in top-down games; add Damage to hurt on contact.', code: CHASE_PATH },
  { name: 'ParticleEmitter', folder: 'fx', summary: 'Emits particles continuously: dust trails, torches, auras, smoke.', usage: 'Put it on the player (dust, onlyWhenMoving), on torches (sparks) or magic items (magic).', code: PARTICLE_EMITTER },
  { name: 'Spawner', folder: 'level', summary: 'Spawns an object every few seconds, up to a maximum.', usage: 'Put it on an invisible marker object, or on a scene with offsetX/offsetY.', code: SPAWNER },
  { name: 'Countdown', folder: 'level', summary: 'Level timer: counts down, shows it, then restarts or changes scene.', usage: 'Put it on a scene.', code: COUNTDOWN },
];

export const LIBRARY_MAP = new Map(LIBRARY.map((c) => [c.name, c]));
