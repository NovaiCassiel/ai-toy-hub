// Live canvas: replays a score's timed pen points. Ink accumulates on one layer,
// the glowing pen tip lives on another, and the meter shows what the toy feels now.
const hue = (level) => 215 + level * 115; // calm blue → hot pink

// onLevel(level) mirrors what the toy feels while a score plays; onBusy(bool) brackets playback.
export function createBoard({ ink, tip, meter, note, onLevel = () => {}, onBusy = () => {} }) {
  const a = ink.getContext('2d');
  const b = tip.getContext('2d');
  let frame = 0;

  function clear() {
    a.clearRect(0, 0, ink.width, ink.height);
    b.clearRect(0, 0, tip.width, tip.height);
  }

  function segment(p, q) {
    const level = q[3];
    a.strokeStyle = `hsl(${hue(level)} 90% ${62 + level * 10}%)`;
    a.lineWidth = 5 + level * 18;
    a.shadowColor = a.strokeStyle;
    a.shadowBlur = level * 22;
    a.beginPath();
    a.moveTo(p[0], p[1]);
    a.lineTo(q[0], q[1]);
    a.stroke();
  }

  function pen(p) {
    b.clearRect(0, 0, tip.width, tip.height);
    if (!p) return;
    const r = 10 + p[3] * 26;
    const g = b.createRadialGradient(p[0], p[1], 0, p[0], p[1], r * 2.4);
    g.addColorStop(0, `hsl(${hue(p[3])} 100% 85% / .95)`);
    g.addColorStop(1, `hsl(${hue(p[3])} 100% 60% / 0)`);
    b.fillStyle = g;
    b.beginPath();
    b.arc(p[0], p[1], r * 2.4, 0, Math.PI * 2);
    b.fill();
  }

  function setMeter(level) {
    meter.style.width = `${Math.round(level * 100)}%`;
    onLevel(level);
  }
  function finish() { frame = 0; pen(null); setMeter(0); onBusy(false); }

  function play(score, who) {
    cancelAnimationFrame(frame);
    a.lineCap = a.lineJoin = 'round';
    if (score.clear) clear();
    if (score.replay) {
      score.strokes.forEach(({ pts }) => pts.forEach((q, i) => i && segment(pts[i - 1], q)));
      const name = score.label.replace(/^(写字|重播)：/, '');
      note.textContent = score.source === 'replay' ? `上次重播的「${name}」` : `${who}留下的「${name}」`;
      return;
    }
    note.textContent = score.label.startsWith('重播')
      ? `正在${score.label.replace('：', '「')}」`
      : `${who}正在${score.label.startsWith('写字') ? '写' : '画'}…`;
    onBusy(true);
    const drawn = score.strokes.map(() => 0);
    const start = performance.now();
    const tick = (now) => {
      const t = now - start;
      let head = null;
      score.strokes.forEach(({ pts }, s) => {
        while (drawn[s] < pts.length && pts[drawn[s]][2] <= t) {
          if (drawn[s]) segment(pts[drawn[s] - 1], pts[drawn[s]]);
          drawn[s] += 1;
        }
        if (drawn[s] && drawn[s] < pts.length) head = pts[drawn[s] - 1];
      });
      pen(head);
      setMeter(head ? head[3] : 0);
      if (t < score.duration) frame = requestAnimationFrame(tick);
      else { finish(); note.textContent = `${who}写完了「${score.label.replace(/^(写字|重播)：/, '')}」`; }
    };
    frame = requestAnimationFrame(tick);
  }

  // Voice: the waveform unrolls left to right on the shared clock, subtitle below.
  function playVoice(score, who, startAt) {
    cancelAnimationFrame(frame);
    clear();
    const wave = score.wave || [];
    const w = ink.width / Math.max(1, wave.length);
    const mid = ink.height / 2;
    const bar = (i) => {
      const level = wave[i];
      const h = 6 + level * ink.height * 0.38;
      a.fillStyle = `hsl(${hue(level)} 90% ${60 + level * 12}%)`;
      a.shadowColor = a.fillStyle;
      a.shadowBlur = level * 18;
      a.fillRect(i * w + w * 0.15, mid - h / 2, Math.max(1, w * 0.7), h);
    };
    const subtitle = (score.text || '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
    if (score.replay) {
      wave.forEach((_, i) => bar(i));
      note.textContent = `「${subtitle}」`;
      return;
    }
    note.textContent = `${who}要开口了…`;
    onBusy(true);
    let drawn = 0;
    const tick = (now) => {
      const t = now - startAt;
      if (t >= 0) {
        note.textContent = `${who}：「${subtitle}」`;
        const upto = Math.min(wave.length, Math.floor(t / 100) + 1);
        while (drawn < upto) bar(drawn++);
        const level = wave[Math.min(wave.length - 1, Math.max(0, upto - 1))] || 0;
        pen(upto < wave.length ? [upto * w, mid, 0, level] : null);
        setMeter(upto < wave.length ? level : 0);
      }
      if (t < score.duration) frame = requestAnimationFrame(tick);
      else finish();
    };
    frame = requestAnimationFrame(tick);
  }

  // Freeze whatever was drawn so far; used when the toy is stopped mid-way.
  function stop(text) {
    if (!frame) return;
    cancelAnimationFrame(frame);
    finish();
    if (text) note.textContent = text;
  }

  return { play, playVoice, clear, stop };
}
