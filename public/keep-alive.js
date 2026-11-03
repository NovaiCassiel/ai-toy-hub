// Android freezes a browser page once it is hidden, which would silently cut the toy off when the
// user switches to a chat app. A page playing audio with a media session is kept running, so the relay
// loops a sound far too quiet to hear (about -66 dBFS) and shows up as a media notification.
function quietLoop() {
  const rate = 8000; const n = rate * 2;
  const bytes = new DataView(new ArrayBuffer(44 + n * 2));
  const text = (at, s) => [...s].forEach((c, i) => bytes.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF'); bytes.setUint32(4, 36 + n * 2, true); text(8, 'WAVEfmt ');
  bytes.setUint32(16, 16, true); bytes.setUint16(20, 1, true); bytes.setUint16(22, 1, true);
  bytes.setUint32(24, rate, true); bytes.setUint32(28, rate * 2, true); bytes.setUint16(32, 2, true); bytes.setUint16(34, 16, true);
  text(36, 'data'); bytes.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) bytes.setInt16(44 + i * 2, Math.random() < 0.5 ? 16 : -16, true);
  return URL.createObjectURL(new Blob([bytes.buffer], { type: 'audio/wav' }));
}

// Must be called from a tap. Resolves false if the browser refused to play.
export async function startKeepAlive() {
  const audio = new Audio(quietLoop());
  audio.loop = true;
  // Another app may take audio focus and pause us; resume as soon as the page can.
  audio.addEventListener('pause', () => setTimeout(() => audio.play().catch(() => {}), 1000));
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: '小玩具中继运行中', artist: '切到别的 App 也不会断' });
  }
  try { await audio.play(); return true; } catch { return false; }
}
