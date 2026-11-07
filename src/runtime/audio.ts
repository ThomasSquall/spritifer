/** Tiny synthesized retro sound effects (no audio files needed). */

type Wave = OscillatorType | 'noise';

interface Sfx {
  wave: Wave;
  /** Start and end frequency in Hz. */
  from: number;
  to: number;
  duration: number;
  /** Optional second tone after the first one (coin "ding-ding"). */
  then?: { from: number; to: number; duration: number };
}

const SFX: Record<string, Sfx> = {
  jump: { wave: 'square', from: 260, to: 620, duration: 0.14 },
  coin: { wave: 'square', from: 990, to: 990, duration: 0.07, then: { from: 1320, to: 1320, duration: 0.18 } },
  hit: { wave: 'sawtooth', from: 300, to: 80, duration: 0.15 },
  hurt: { wave: 'square', from: 420, to: 120, duration: 0.25 },
  explosion: { wave: 'noise', from: 1, to: 0, duration: 0.5 },
  powerup: { wave: 'triangle', from: 300, to: 1200, duration: 0.45 },
  laser: { wave: 'sawtooth', from: 1500, to: 200, duration: 0.18 },
  blip: { wave: 'square', from: 660, to: 660, duration: 0.05 },
  select: { wave: 'triangle', from: 520, to: 880, duration: 0.1 },
  step: { wave: 'noise', from: 0.3, to: 0, duration: 0.04 },
};

export class SoundBoard {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  muted = false;

  /** Must be called from a user gesture before sounds can play in most browsers. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  play(name: string, volume = 0.5): void {
    const ctx = this.ctx;
    const sfx = SFX[name];
    if (!ctx || !sfx || this.muted) return;
    const t0 = ctx.currentTime;
    const end = this.tone(ctx, sfx.wave, sfx.from, sfx.to, sfx.duration, t0, volume);
    if (sfx.then) this.tone(ctx, sfx.wave, sfx.then.from, sfx.then.to, sfx.then.duration, end, volume);
  }

  private tone(ctx: AudioContext, wave: Wave, from: number, to: number, dur: number, at: number, volume: number): number {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(Math.max(0, Math.min(1, volume)) * 0.3, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    gain.connect(ctx.destination);
    if (wave === 'noise') {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(4000 * Math.max(0.05, from), at);
      filter.frequency.exponentialRampToValueAtTime(100 + 4000 * Math.max(0.01, to), at + dur);
      src.connect(filter).connect(gain);
      src.start(at);
      src.stop(at + dur);
    } else {
      const osc = ctx.createOscillator();
      osc.type = wave;
      osc.frequency.setValueAtTime(from, at);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + dur);
      osc.connect(gain);
      osc.start(at);
      osc.stop(at + dur);
    }
    return at + dur;
  }
}
