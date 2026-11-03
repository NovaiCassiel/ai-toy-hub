// Which step of a [level, ms] timeline is due after `elapsed` ms. Reading from the clock (rather
// than chaining one timer per step) keeps playback on time even when the browser throttles timers.
export function stepAt(steps, elapsed, loop) {
  const total = steps.reduce((sum, [, ms]) => sum + ms, 0);
  if (!total || (!loop && elapsed >= total)) return { done: true, index: -1, level: 0 };
  let t = loop ? elapsed % total : elapsed;
  for (let index = 0; index < steps.length; index++) {
    if (t < steps[index][1]) return { done: false, index, level: steps[index][0] };
    t -= steps[index][1];
  }
  return { done: true, index: -1, level: 0 };
}
