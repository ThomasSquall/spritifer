/**
 * Sound for games: tiny synthesized retro effects (no files needed), the project's audio files
 * (effects and music, decoded with Web Audio) and music with crossfades and separate volumes.
 */

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

export interface MusicCmd {
  type: 'play' | 'stop' | 'volume';
  name?: string;
  volume?: number;
  loop?: boolean;
  fade?: number;
  channel?: 'music' | 'sfx';
  value?: number;
}

export class SoundBoard {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  muted = false;
  /** Audio files by name (data or http URLs). */
  private files: Record<string, string> = {};
  private decoded = new Map<string, Promise<AudioBuffer | null>>();
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private volumes = { music: 1, sfx: 1 };
  /** Music switched off: the track keeps running silently, so switching back resumes it. */
  private musicOff = false;
  private track: { name: string; src: AudioBufferSourceNode | null; gain: GainNode | null; volume: number } | null = null;
  /** Music asked for before audio was unlocked (first key or click): starts then. */
  private pendingMusic: MusicCmd | null = null;

  get musicMuted(): boolean {
    return this.musicOff;
  }

  set musicMuted(off: boolean) {
    this.musicOff = off;
    if (this.musicGain && this.ctx) this.musicGain.gain.setTargetAtTime(this.musicLevel(), this.ctx.currentTime, 0.05);
  }

  private musicLevel(): number {
    return this.musicOff ? 0 : this.volumes.music;
  }

  setFiles(files: Record<string, string> | undefined): void {
    this.files = files ?? {};
    this.decoded.clear();
  }

  private buffer(name: string): Promise<AudioBuffer | null> {
    const ctx = this.ctx;
    const url = this.files[name];
    if (!ctx || !url) return Promise.resolve(null);
    let p = this.decoded.get(name);
    if (!p) {
      p = fetch(url)
        .then((r) => r.arrayBuffer())
        .then((b) => ctx.decodeAudioData(b))
        .catch(() => null);
      this.decoded.set(name, p);
    }
    return p;
  }

  private out(channel: 'music' | 'sfx'): AudioNode {
    const ctx = this.ctx!;
    if (!this.sfxGain) {
      this.sfxGain = ctx.createGain();
      this.sfxGain.gain.value = this.volumes.sfx;
      this.sfxGain.connect(ctx.destination);
      this.musicGain = ctx.createGain();
      this.musicGain.gain.value = this.musicLevel();
      this.musicGain.connect(ctx.destination);
    }
    return channel === 'music' ? this.musicGain! : this.sfxGain;
  }

  /** Music commands from the engine. */
  music(cmd: MusicCmd): void {
    if (cmd.type === 'volume') {
      const v = Math.max(0, Math.min(1, cmd.value ?? 1));
      this.volumes[cmd.channel === 'music' ? 'music' : 'sfx'] = v;
      const g = cmd.channel === 'music' ? this.musicGain : this.sfxGain;
      if (g && this.ctx) g.gain.setTargetAtTime(cmd.channel === 'music' ? this.musicLevel() : v, this.ctx.currentTime, 0.05);
      return;
    }
    const ctx = this.ctx;
    if (!ctx) {
      this.pendingMusic = cmd.type === 'play' ? cmd : null;
      return;
    }
    const fade = Math.max(0.01, cmd.fade ?? 1);
    const old = this.track;
    if (old?.gain) {
      old.gain.gain.cancelScheduledValues(ctx.currentTime);
      old.gain.gain.setValueAtTime(old.gain.gain.value, ctx.currentTime);
      old.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + fade);
      old.src?.stop(ctx.currentTime + fade + 0.05);
    }
    this.track = null;
    if (cmd.type !== 'play' || !cmd.name) return;
    const track = { name: cmd.name, src: null as AudioBufferSourceNode | null, gain: null as GainNode | null, volume: cmd.volume ?? 0.6 };
    this.track = track;
    void this.buffer(cmd.name).then((buf) => {
      if (!buf || this.track !== track || !this.ctx) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = cmd.loop !== false;
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0, this.ctx.currentTime);
      gain.gain.linearRampToValueAtTime(track.volume, this.ctx.currentTime + fade);
      src.connect(gain).connect(this.out('music'));
      src.start();
      track.src = src;
      track.gain = gain;
    });
  }

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
    // Decode the files now so the first effects play on time.
    for (const n of Object.keys(this.files)) void this.buffer(n);
    if (this.pendingMusic) {
      const m = this.pendingMusic;
      this.pendingMusic = null;
      this.music(m);
    }
  }

  play(name: string, volume = 0.5): void {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    if (!SFX[name] && this.files[name]) {
      // An audio file from the project.
      void this.buffer(name).then((buf) => {
        if (!buf || !this.ctx) return;
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        const g = this.ctx.createGain();
        g.gain.value = Math.max(0, Math.min(1, volume * 2));
        src.connect(g).connect(this.out('sfx'));
        src.start();
      });
      return;
    }
    const sfx = SFX[name];
    if (!sfx) return;
    const t0 = ctx.currentTime;
    const end = this.tone(ctx, sfx.wave, sfx.from, sfx.to, sfx.duration, t0, volume);
    if (sfx.then) this.tone(ctx, sfx.wave, sfx.then.from, sfx.then.to, sfx.then.duration, end, volume);
  }

  private tone(ctx: AudioContext, wave: Wave, from: number, to: number, dur: number, at: number, volume: number): number {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(Math.max(0, Math.min(1, volume)) * 0.3, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    gain.connect(this.out('sfx'));
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
