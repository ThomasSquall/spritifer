// Villagers: the elder gives a quest, the merchant sells potions.

const elderSays = (text) => say(text, { speaker: 'Elder' })

behavior('elder', {
  interact: async (self, player) => {
    if (!vars.metElder) {
      await elderSays('Welcome to Mossbrook, traveler.')
      await elderSays('Slimes have been eating our cabbages all summer...')
      const c = await choose(['I will help!', 'Not my problem.'], { text: 'Will you chase them away?', speaker: 'Elder' })
      vars.metElder = true
      if (c === 0) {
        vars.quest = 1
        vars.potions += 1
        sound('powerup')
        await elderSays('Bless you! Take this potion. Walk into a slime to fight it.')
      } else {
        await elderSays('Hmph. Come back if you change your mind.')
      }
      return
    }
    const left = find('slime').length
    if (left > 0) {
      if (!vars.quest) {
        const c = await choose(['Fine, I will help.', 'Still no.'], { text: 'Changed your mind?', speaker: 'Elder' })
        if (c === 0) { vars.quest = 1; await elderSays('Thank you!') }
        return
      }
      await elderSays(left === 1 ? 'Only one slime left!' : left + ' slimes still roam the village.')
    } else if (!vars.questDone) {
      vars.questDone = true
      vars.gold += 20
      sound('coin')
      await elderSays('The slimes are gone! Here are 20 gold, hero.')
    } else {
      await elderSays('Thanks to you, the cabbages are safe.')
    }
  },
})

behavior('merchant', {
  interact: async () => {
    const sp = { speaker: 'Merchant' }
    await say('Potions! Fresh potions!', sp)
    while (true) {
      const c = await choose(['Buy potion (10 gold)', 'Leave'], { text: 'You have ' + vars.gold + ' gold.', speaker: 'Merchant' })
      if (c !== 0) break
      if (vars.gold < 10) { await say("You can't afford that, friend.", sp); break }
      vars.gold -= 10
      vars.potions += 1
      sound('coin')
    }
    await say('Come again!', sp)
  },
})

behavior('chest', {
  create(self) {
    if (String(vars.opened).includes('|' + self.sceneId + '|')) self.play('open')
  },
  interact: async (self) => {
    if (self.animation === 'open') return say('It is empty.')
    self.play('open')
    sound('powerup')
    vars.gold += 15
    vars.opened = String(vars.opened) + '|' + self.sceneId + '|'
    await say('You found 15 gold!')
  },
})

onStart(async () => {
  await wait(0.4)
  await say('Explore Mossbrook. Walk with the arrows, press Space or Z next to people and things.')
})
