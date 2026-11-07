import { FOES } from 'data/foes'

/**
 * Turn-based battle, attached to the battle scene. The town is a persistent scene:
 * coming back from a battle, everyone is where they were.
 */
export default class Battle extends Behaviour {
  returnScene = 'town'
  potionHeal = 10
  static params = { returnScene: 'scene', potionHeal: { min: 1, max: 50 } }

  awake() {
    this.def = FOES[vars.foe] ?? FOES.slime
    this.hp = this.def.hp
    this.foe = findOne('foe')
    this.hero = findOne('hero_battle')
  }

  async start() {
    await this.wait(0.3)
    await say('A wild ' + this.def.name + ' appears!')
    let fled = false
    while (this.hp > 0 && vars.hp > 0) {
      const c = await choose(['Attack', 'Potion (' + vars.potions + ')', 'Run'], { text: 'What will you do?' })
      if (c === 0) await this.attack()
      else if (c === 1) {
        if (vars.potions <= 0) { await say('No potions left!'); continue }
        vars.potions -= 1
        vars.hp = Math.min(vars.maxHp, vars.hp + this.potionHeal)
        sound('powerup')
        await say('You drink a potion. +' + this.potionHeal + ' HP')
      } else {
        if (random() < 0.6) { sound('select'); await say('You got away safely.'); fled = true; break }
        await say("You couldn't escape!")
      }
      if (this.hp > 0) await this.foeTurn()
    }
    await this.finish(fled)
  }

  async attack() {
    await this.hero.moveBy(24, 0, 200)
    const dmg = randint(3, 6)
    this.hp = Math.max(0, this.hp - dmg)
    this.foe.flash(0.4)
    sound('hit')
    shake(2, 0.2)
    await this.hero.moveBy(-24, 0, 200)
    await say('You hit the ' + this.def.name + ' for ' + dmg + '!')
  }

  async foeTurn() {
    const dmg = randint(this.def.attack[0], this.def.attack[1])
    vars.hp = Math.max(0, vars.hp - dmg)
    this.hero.flash(0.4)
    sound('hurt')
    await say('The ' + this.def.name + ' hits you for ' + dmg + '.')
  }

  async finish(fled) {
    if (this.hp <= 0) {
      this.foe.destroy()
      sound('explosion')
      vars.gold += this.def.gold
      vars.slain = String(vars.slain) + ',' + vars.foeId
      await say('Victory! You found ' + this.def.gold + ' gold.')
    } else if (vars.hp <= 0) {
      await say('You fainted... The elder nursed you back to health.')
      vars.hp = vars.maxHp
    }
    if (fled || vars.hp > 0) vars.grace = game.clock + 2
    goto(this.returnScene)
  }

  onDraw(ui) {
    ui.panel(8, 8, 116, 26)
    ui.text('HERO', 13, 12, { color: '#ffcd75' })
    ui.text(vars.hp + '/' + vars.maxHp, 119, 12, { align: 'right' })
    ui.bar(13, 21, 106, 8, vars.hp, vars.maxHp, '#38b764')
    ui.panel(ui.width - 124, 8, 116, 26)
    ui.text(this.def.name.toUpperCase(), ui.width - 119, 12, { color: '#ffcd75' })
    ui.bar(ui.width - 119, 21, 106, 8, this.hp, this.def.hp, '#e43b44')
  }
}
