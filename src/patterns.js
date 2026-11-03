'use strict';

// Preset rhythms. Each step is [level 0..1, durationMs]; the bridge loops them.
const ramp = (from, to, ms, n) => Array.from({ length: n }, (_, i) => [from + ((to - from) * i) / (n - 1), ms / n]);

const PATTERNS = {
  pulse: { label: '脉冲', steps: [[0.8, 400], [0, 400]] },
  wave: { label: '波浪', steps: [...ramp(0.15, 0.9, 2000, 10), ...ramp(0.9, 0.15, 2000, 10)] },
  heartbeat: { label: '心跳', steps: [[0.9, 150], [0.2, 150], [0.75, 150], [0.1, 750]] },
  tease: { label: '撩拨', steps: [[0.3, 1500], [0, 800], [0.6, 400], [0, 1200], [0.45, 2000], [0, 600]] },
  climb: { label: '爬坡', steps: [...ramp(0.1, 1, 30000, 30), [1, 5000], [0.1, 2000]] },
  storm: { label: '暴风', steps: [[1, 200], [0.4, 150], [0.9, 300], [0.6, 120], [1, 500], [0.3, 200]] },
};

function resolvePattern(input, maxSteps = 200) {
  if (typeof input === 'string') {
    const preset = PATTERNS[input];
    if (!preset) throw new Error(`unknown pattern: ${input}; presets: ${Object.keys(PATTERNS).join(', ')}`);
    return { name: input, steps: preset.steps };
  }
  if (!Array.isArray(input) || !input.length || input.length > maxSteps) throw new Error(`pattern steps must be 1-${maxSteps} items`);
  const steps = input.map((s) => {
    const level = Array.isArray(s) ? s[0] : s.level;
    const ms = Array.isArray(s) ? s[1] : s.ms;
    // Accept 0..100 from humans/models, store 0..1.
    const norm = Number(level) > 1 ? Number(level) / 100 : Number(level);
    if (!Number.isFinite(norm) || !Number.isFinite(Number(ms))) throw new Error('each step needs level and ms');
    return [Math.min(1, Math.max(0, norm)), Math.min(60000, Math.max(100, Number(ms)))];
  });
  return { name: 'custom', steps };
}

module.exports = { PATTERNS, resolvePattern };
