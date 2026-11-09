import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoundBoard } from '../src/runtime/audio.js';

/** Just enough of Web Audio to read the level of the music channel. */
function fakeAudio() {
  const gains: { gain: { value: number; setTargetAtTime: (v: number) => void } }[] = [];
  class FakeContext {
    state = 'running';
    currentTime = 0;
    sampleRate = 8;
    destination = {};
    createBuffer = () => ({ getChannelData: () => new Float32Array(8) });
    createGain = () => {
      const gain = { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime(v: number) { gain.value = v; } };
      const node = { gain, connect: () => node };
      gains.push(node);
      return node;
    };
    createOscillator = () => ({ frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, start() {}, stop() {} });
  }
  vi.stubGlobal('window', { AudioContext: FakeContext });
  const board = new SoundBoard();
  board.unlock();
  board.play('blip'); // Builds the channels: the tone's gain, then sfx, then music.
  return { board, music: () => gains[2]!.gain.value };
}

describe('music volume of the player', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lowers the music on a curve, on top of the volume the game asks for', () => {
    const { board, music } = fakeAudio();
    expect(music()).toBe(1);
    board.musicVolume = 0.5;
    expect(music()).toBeCloseTo(0.25);
    board.music({ type: 'volume', channel: 'music', value: 0.8 });
    expect(music()).toBeCloseTo(0.2);
  });

  it('stays silent while the music is off and comes back at the chosen volume', () => {
    const { board, music } = fakeAudio();
    board.musicVolume = 0.5;
    board.musicMuted = true;
    expect(music()).toBe(0);
    board.musicMuted = false;
    expect(music()).toBeCloseTo(0.25);
  });

  it('keeps the volume between 0 and 1', () => {
    const { board } = fakeAudio();
    board.musicVolume = 3;
    expect(board.musicVolume).toBe(1);
    board.musicVolume = -1;
    expect(board.musicVolume).toBe(0);
  });
});
