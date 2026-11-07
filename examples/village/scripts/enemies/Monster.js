import { slainIds } from 'data/foes'

/**
 * A monster on the map: touching it starts a battle. Defeated monsters stay defeated.
 */
export default class Monster extends Behaviour {
  // Which entry of data/foes.js you fight.
  foe = 'slime'
  battleScene = 'battle'
  static params = { battleScene: 'scene', foe: { help: 'Key in data/foes.js' } }

  awake() {
    if (slainIds().includes(String(this.self.sceneId))) this.self.destroy()
  }

  onCollisionEnter(other) {
    if (other.object !== 'player' || game.clock < vars.grace) return
    vars.foeId = this.self.sceneId
    vars.foe = this.foe
    sound('blip')
    goto(this.battleScene)
  }
}
