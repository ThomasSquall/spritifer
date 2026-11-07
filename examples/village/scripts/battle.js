// Turn-based battles: touching a slime on the map starts one.

const FOES = { slime: { name: 'Slime', hp: 12, attack: [1, 4], gold: 5 } }
let battle = null

behavior('monster', {
  create(self) {
    // Defeated monsters stay defeated.
    if (String(vars.slain).split(',').includes(String(self.sceneId))) self.destroy()
  },
  collide(self, other) {
    if (other.name !== 'player' || battle || game.clock < vars.grace) return
    vars.returnX = other.x
    vars.returnY = other.y
    vars.foeId = self.sceneId
    sound('blip')
    goto('battle')
  },
})

// Coming back from a battle: put the player where the fight started.
onSceneStart('town', () => {
  const p = player()
  if (p && vars.returnX) {
    p.x = vars.returnX
    p.y = vars.returnY
  }
})

onSceneStart('battle', async () => {
  const def = FOES.slime
  const foe = findOne('foe')
  const hero = findOne('hero_battle')
  battle = { name: def.name, hp: def.hp, max: def.hp }
  await wait(0.3)
  await say('A wild ' + battle.name + ' appears!')
  let fled = false
  while (battle.hp > 0 && vars.hp > 0) {
    const c = await choose(['Attack', 'Potion (' + vars.potions + ')', 'Run'], { text: 'What will you do?' })
    if (c === 0) {
      await hero.moveBy(24, 0, 200)
      const dmg = randint(3, 6)
      battle.hp = Math.max(0, battle.hp - dmg)
      foe.flash(0.4)
      sound('hit')
      shake(2, 0.2)
      await hero.moveBy(-24, 0, 200)
      await say('You hit the ' + battle.name + ' for ' + dmg + '!')
    } else if (c === 1) {
      if (vars.potions <= 0) { await say('No potions left!'); continue }
      vars.potions -= 1
      vars.hp = Math.min(vars.maxHp, vars.hp + 10)
      sound('powerup')
      await say('You drink a potion. +10 HP')
    } else {
      if (random() < 0.6) { sound('select'); await say('You got away safely.'); fled = true; break }
      await say("You couldn't escape!")
    }
    if (battle.hp > 0) {
      const dmg = randint(def.attack[0], def.attack[1])
      vars.hp = Math.max(0, vars.hp - dmg)
      hero.flash(0.4)
      sound('hurt')
      await say('The ' + battle.name + ' hits you for ' + dmg + '.')
    }
  }
  if (battle.hp <= 0) {
    foe.destroy()
    sound('explosion')
    vars.gold += def.gold
    vars.slain = String(vars.slain) + ',' + vars.foeId
    await say('Victory! You found ' + def.gold + ' gold.')
  } else if (vars.hp <= 0) {
    await say('You fainted... The elder nursed you back to health.')
    vars.hp = vars.maxHp
    vars.returnX = 0
  }
  if (fled || vars.hp > 0) vars.grace = game.clock + 2
  battle = null
  goto('town')
})

// HUD on the map, HP bars in battle.
onDraw((ui) => {
  if (scene.name === 'town') {
    ui.panel(4, 4, 104, 25, { alpha: 0.85 })
    ui.text('HP', 9, 8, { color: '#ffcd75' })
    ui.bar(21, 8, 82, 6, vars.hp, vars.maxHp, '#38b764')
    ui.text('GOLD ' + vars.gold + '   POTIONS ' + vars.potions, 9, 18)
    if (vars.quest && !vars.questDone) ui.text('SLIMES LEFT ' + find('slime').length, ui.width - 6, 6, { align: 'right', color: '#ffcd75' })
  }
  if (scene.name === 'battle' && battle) {
    ui.panel(8, 8, 116, 26)
    ui.text('HERO', 13, 12, { color: '#ffcd75' })
    ui.text(vars.hp + '/' + vars.maxHp, 119, 12, { align: 'right' })
    ui.bar(13, 21, 106, 8, vars.hp, vars.maxHp, '#38b764')
    ui.panel(ui.width - 124, 8, 116, 26)
    ui.text(battle.name.toUpperCase(), ui.width - 119, 12, { color: '#ffcd75' })
    ui.bar(ui.width - 119, 21, 106, 8, battle.hp, battle.max, '#e43b44')
  }
})
