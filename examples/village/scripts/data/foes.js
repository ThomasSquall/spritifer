// Monster stats, shared by the map (enemies/Monster) and the battle scene (battle/Battle).
export const FOES = {
  slime: { name: 'Slime', hp: 12, attack: [1, 4], gold: 5 },
}

/** Ids of the monsters already defeated (kept in a global variable, so they stay defeated). */
export function slainIds() {
  return String(vars.slain).split(',').filter(Boolean)
}
