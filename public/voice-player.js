import { apiBlob } from './client.js';

// Plays the AI's voice clips through Web Audio so the start time can be scheduled to
// line up with the toy. Phones only allow sound after a tap, hence the unlock button.
export function createVoicePlayer(unlockButton) {
  let ctx = null;
  let source = null;

  const unlocked = () => ctx?.state === 'running';
  function refresh() { unlockButton.hidden = unlocked(); }
  unlockButton.onclick = async () => {
    ctx = ctx || new AudioContext();
    await ctx.resume().catch(() => {});
    refresh();
  };
  refresh();

  // startAt is a performance.now() timestamp; if the audio arrives late it joins mid-way.
  async function play(audioId, startAt) {
    stop();
    if (!unlocked()) return false;
    const buffer = await ctx.decodeAudioData(await apiBlob(`/api/voice/${audioId}`));
    const lateBy = (performance.now() - startAt) / 1000;
    source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    if (lateBy >= buffer.duration) return true;
    if (lateBy > 0) source.start(0, lateBy);
    else source.start(ctx.currentTime - lateBy);
    return true;
  }

  function stop() {
    try { source?.stop(); } catch {}
    source = null;
  }

  let endsAt = 0;
  const playing = () => performance.now() < endsAt;
  const timedPlay = async (audioId, startAt) => {
    const ok = await play(audioId, startAt);
    if (ok && source) endsAt = startAt + source.buffer.duration * 1000 + 300;
    return ok;
  };

  return { play: timedPlay, stop: () => { endsAt = 0; stop(); }, unlocked, playing };
}
