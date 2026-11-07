/**
 * HUD of the town: HP, gold, potions and the slime quest counter.
 */
export default class TownHud extends Behaviour {
  hpColor = '#38b764'
  labelColor = '#ffcd75'

  onDraw(ui) {
    ui.panel(4, 4, 104, 25, { alpha: 0.85 })
    ui.text('HP', 9, 8, { color: this.labelColor })
    ui.bar(21, 8, 82, 6, vars.hp, vars.maxHp, this.hpColor)
    ui.text('GOLD ' + vars.gold + '   POTIONS ' + vars.potions, 9, 18)
    if (vars.quest && !vars.questDone) ui.text('SLIMES LEFT ' + find('slime').length, ui.width - 6, 6, { align: 'right', color: this.labelColor })
  }
}
