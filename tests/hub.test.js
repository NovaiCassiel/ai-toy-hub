const test = require('node:test');
const assert = require('node:assert/strict');
const { ToyHub } = require('../src/hub');
const { handleRpc } = require('../src/mcp');
const { buildScore } = require('../src/score');
const { SavedScores } = require('../src/store');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('saved drawings persist, replay with the same timeline, and soft-delete', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toyhub-'));
  const file = path.join(dir, 'saved.json');
  const { hub, sent } = setup();
  hub.saved = new SavedScores(file);
  assert.throws(() => hub.saved.save(hub.lastScore), /nothing to save/);
  hub.playScore(await buildScore({ shape: 'heart' }), { device: 'vibe', source: 'mcp:companion', label: '画画' });
  const original = sent.at(-1).data.steps;
  const { id } = hub.saved.save(hub.lastScore, '第一颗心');

  const reopened = new SavedScores(file); // survives restart
  assert.equal(reopened.list()[0].name, '第一颗心');
  hub.saved = reopened;
  const res = hub.replaySaved('一颗心');
  assert.equal(res.name, '第一颗心');
  assert.deepEqual(sent.at(-1).data.steps, original);
  assert.equal(sent.at(-1).data.loop, false);
  assert.equal(hub.lastScore.label, '重播：第一颗心');

  reopened.remove(id);
  assert.equal(reopened.list().length, 0);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8'))[0].deletedAt, 'kept on disk for recovery');
  assert.throws(() => hub.replaySaved(id), /not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('voice: loudness envelope drives a delayed, non-looping timeline and saves with its audio', async () => {
  const { buildVoiceScore, envelopeToSteps } = require('../src/voice');
  const rms = [0, 0, 0.02, 0.2, 0.4, 0.4, 0.1, 0, 0, 0.3];
  const { steps, wave } = envelopeToSteps(rms, 0.8);
  assert.equal(steps.reduce((s, [, ms]) => s + ms, 0), rms.length * 100);
  assert.equal(steps[0][0], 0, 'silence rests');
  assert.ok(Math.max(...steps.map(([l]) => l)) <= 0.8);
  assert.equal(wave.length, rms.length);

  const score = await buildVoiceScore({ text: '[whispers] 你好…', intensity: 60 }, { apiKey: 'k', voice_id: 'v' }, {
    synthesize: async (text) => Buffer.from(text), loudness: async () => rms,
  });
  assert.equal(score.kind, 'voice');
  assert.equal(score.duration, 1000);
  await assert.rejects(buildVoiceScore({ text: '  ' }, {}), /text is required/);

  const { hub, sent } = setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toyhub-'));
  hub.saved = new SavedScores(path.join(dir, 's.json'));
  const { audio, ...rest } = score;
  hub.playScore({ ...rest, audioId: '00000000-0000-0000-0000-000000000001' }, { device: 'vibe', source: 'mcp:companion', label: '说：你好' });
  assert.equal(sent.at(-1).data.startIn, 1500);
  assert.equal(hub.lastScore.kind, 'voice');
  hub.saved.save(hub.lastScore, '耳语');
  assert.ok(hub.saved.audioIds().has('00000000-0000-0000-0000-000000000001'));
  hub.replaySaved('耳语');
  assert.equal(hub.lastScore.text, '[whispers] 你好…');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('voice: ffmpeg loudness reads a real tone with a silent gap', async (t) => {
  const { loudness } = require('../src/voice');
  const { execFileSync } = require('child_process');
  let mp3;
  try {
    mp3 = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=0.5',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=0.5', '-filter_complex', '[0][1]concat=n=2:v=0:a=1', '-f', 'mp3', 'pipe:1']);
  } catch { t.skip('ffmpeg not available'); return; }
  const rms = await loudness(mp3);
  assert.ok(rms.length >= 9 && rms.length <= 12, `got ${rms.length} buckets`);
  assert.ok(rms[2] > 0.05 && rms.at(-2) < 0.01, `tone ${rms[2]} / gap ${rms.at(-2)}`); // lavfi sine is 1/8 amplitude
});

test('audio clips: stored by id, ids validated, unsaved old clips pruned', () => {
  const { AudioClips } = require('../src/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toyclips-'));
  const keep = new Set();
  const clips = new AudioClips(dir, { keep: () => keep });
  const a = clips.put(Buffer.from('a'));
  const b = clips.put(Buffer.from('b'));
  keep.add(a);
  assert.ok(clips.file(a) && clips.file(b), 'fresh clips survive the default age');
  assert.equal(clips.file('../../etc/passwd'), null);
  clips.maxAgeMs = -1000; // everything counts as old now
  clips.prune();
  assert.ok(clips.file(a), 'saved clip kept');
  assert.equal(clips.file(b), null, 'unsaved clip pruned');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('drawing still reaches the canvas when no toy is online', async () => {
  const hub = new ToyHub();
  const seen = [];
  hub.watch((event) => seen.push(event));
  const res = hub.playScore(await buildScore({ shape: 'circle' }), { label: '画画' });
  assert.equal(res.toyOffline, true);
  assert.ok(seen.includes('score'));
  assert.throws(() => hub.command({ action: 'stop', source: 'mcp:companion' }), /no toy connected/);
  assert.ok(seen.includes('halt'), 'stop still tells panels to cut the drawing');
});

test('senses: toy_listen waits for the user, gathers what follows, and times out quietly', async () => {
  const { hub } = setup();
  assert.equal(hub.state().userMicOn, false);
  const quiet = await handleRpc(hub, { id: 1, method: 'tools/call', params: { name: 'toy_listen', arguments: { seconds: 1 } } });
  const q = JSON.parse(quiet.result.content[0].text);
  assert.deepEqual(q.heard, []);
  assert.match(q.note, /mic is off/);

  const pending = handleRpc(hub, { id: 2, method: 'tools/call', params: { name: 'toy_listen', arguments: { seconds: 10 } } });
  setTimeout(() => hub.senses.add({ sounds: [{ label: '喘息', score: 0.71 }, { label: 'x'.repeat(50), score: 0.2 }], loudness: 0.4 }), 50);
  setTimeout(() => hub.senses.add({ kind: 'speech', text: '再重一点…' }), 300);
  const started = Date.now();
  const heard = JSON.parse((await pending).result.content[0].text);
  assert.ok(Date.now() - started < 3000, 'returns soon after the user reacts, not at the timeout');
  assert.equal(heard.userMicOn, true);
  assert.deepEqual(heard.heard.map((e) => e.kind), ['sound', 'speech']);
  assert.equal(heard.heard[0].sounds[1].label.length, 20);
  assert.equal(hub.state().heard.at(-1).text, '再重一点…');
  assert.equal(hub.senses.add({ sounds: [] }), null, 'empty events are dropped');
});

test('toy nicknames persist, show in state, and can address the toy', () => {
  const { ToyAliases } = require('../src/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toynames-'));
  const file = path.join(dir, 'names.json');
  const { hub, sent } = setup();
  hub.aliases = new ToyAliases(file);
  hub.aliases.set('Test Vibe', '小蛋');
  assert.equal(new ToyAliases(file).get('Test Vibe'), '小蛋', 'survives restart');
  assert.equal(hub.listDevices().find((d) => d.id === 'vibe').alias, '小蛋');
  hub.command({ action: 'level', level: 30, device: '小蛋' });
  assert.equal(sent.at(-1).data.deviceId, 'vibe');
  hub.aliases.set('Test Vibe', '  ');
  assert.equal(hub.listDevices().find((d) => d.id === 'vibe').alias, null, 'blank restores the original name');
  hub.feedback('came');
  assert.equal(hub.state().feedback.at(-1).label, '到了');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a relay that stops beating is reported asleep, and commands say so', () => {
  let clock = 1000;
  const hub = new ToyHub({ now: () => clock });
  hub.attachBridge('b-test', () => {});
  hub.report('b-test', [{ id: 'vibe', name: 'Test Vibe', actuators: [{ type: 'Vibrate' }] }]);
  const emitted = [];
  hub.watch((event, data) => { if (event === 'state') emitted.push(data.relayAsleep); });
  assert.equal(hub.command({ action: 'level', level: 20 }).relayAsleep, undefined);
  clock += 31000;
  hub.checkRelays();
  assert.equal(hub.state().relayAsleep, true);
  assert.equal(emitted.at(-1), true, 'open panels are told');
  assert.match(hub.command({ action: 'level', level: 20 }).note, /asleep/);
  hub.beat('b-test');
  assert.equal(hub.state().relayAsleep, false);
  assert.equal(emitted.at(-1), false);
  assert.throws(() => hub.beat('nope'), /not connected/);
});

test('timeline playback reads from the clock, so late timers land on the right step', async () => {
  const { stepAt } = await import('../public/timeline.js');
  const steps = [[0.2, 100], [0.8, 200]];
  assert.deepEqual(stepAt(steps, 0, false), { done: false, index: 0, level: 0.2 });
  assert.equal(stepAt(steps, 250, false).level, 0.8);
  assert.equal(stepAt(steps, 300, false).done, true);
  assert.equal(stepAt(steps, 350, true).level, 0.2, 'loops wrap around');
  assert.equal(stepAt([], 0, true).done, true);
});

test('stop tells panels who stopped it', () => {
  const { hub } = setup();
  const halts = [];
  hub.watch((event, data) => { if (event === 'halt') halts.push(data.source); });
  hub.command({ action: 'stop', source: 'panel' });
  hub.command({ action: 'stop', source: 'mcp:companion' });
  assert.deepEqual(halts, ['panel', 'mcp:companion']);
});

function setup() {
  const hub = new ToyHub();
  const sent = [];
  const detach = hub.attachBridge('b-test', (event, data) => sent.push({ event, data }));
  hub.report('b-test', [
    { id: 'vibe', name: 'Test Vibe', driver: 'lovense', actuators: [{ type: 'Vibrate' }] },
    { id: 'bobo', name: '啵啵贝', driver: 'sosexy', actuators: [{ type: 'Vibrate' }, { type: 'Suction' }, { type: 'Electric' }] },
  ]);
  return { hub, sent, detach };
}

test('level command reaches every toy but never touches Electric unless named', () => {
  const { hub, sent } = setup();
  hub.command({ action: 'level', level: 40, seconds: 10 });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].data.actuators, [0, 1]);
  assert.equal(sent[0].data.level, 0.4);
  hub.command({ action: 'level', level: 10, device: '啵啵贝', feature: 'Electric' });
  assert.deepEqual(sent[2].data.actuators, [2]);
});

test('no duration cap by default, 0 runs until stopped, patterns are scaled', () => {
  const { hub, sent } = setup();
  hub.command({ action: 'pattern', pattern: 'pulse', intensity: 50, seconds: 99999, device: 'vibe' });
  assert.equal(sent[0].data.seconds, 99999);
  hub.command({ action: 'level', level: 50, seconds: 0, device: 'vibe' });
  assert.equal(sent[1].data.seconds, 0);
  assert.equal(hub.listDevices().find((d) => d.id === 'vibe').activity.until, null);
  const capped = new ToyHub({ maxSeconds: 600 });
  capped.attachBridge('b', () => {});
  capped.report('b', [{ id: 'x', name: 'x', actuators: [{ type: 'Vibrate' }] }]);
  assert.equal(capped.command({ action: 'level', level: 10, seconds: 0 }).seconds, 600);
  assert.deepEqual(sent[0].data.steps[0], [0.4, 400]);
  assert.throws(() => hub.command({ action: 'pattern', pattern: 'nope' }), /unknown pattern/);
});

test('activity is tracked and cleared on stop or bridge loss', () => {
  const { hub, detach } = setup();
  hub.command({ action: 'level', level: 50, device: 'vibe', source: 'mcp:companion' });
  assert.equal(hub.listDevices().find((d) => d.id === 'vibe').activity.source, 'mcp:companion');
  hub.command({ action: 'stop' });
  assert.equal(hub.listDevices().find((d) => d.id === 'vibe').activity, null);
  detach();
  assert.equal(hub.state().online, false);
  assert.throws(() => hub.command({ action: 'stop' }), /no toy connected/);
});

test('mcp tools list and call', async () => {
  const { hub, sent } = setup();
  const list = await handleRpc(hub, { id: 1, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['toy_status', 'toy_vibrate', 'toy_pattern', 'toy_draw', 'toy_speak', 'toy_listen', 'toy_replay', 'toy_stop']);
  const res = await handleRpc(hub, { id: 2, method: 'tools/call', params: { name: 'toy_vibrate', arguments: { level: 30, device: 'vibe' } } }, 'mcp:test');
  assert.equal(res.result.isError, undefined);
  assert.equal(sent.at(-1).data.level, 0.3);
  const bad = await handleRpc(hub, { id: 3, method: 'tools/call', params: { name: 'toy_pattern', arguments: { pattern: 'nope' } } });
  assert.equal(bad.result.isError, true);
});

test('score: strokes and toy timeline share one clock, taps hit hard, pen lifts rest', async () => {
  const fakeGlyph = async () => [[[0.1, 0.5], [0.9, 0.5]], [[0.5, 0.2], [0.51, 0.21]]]; // a long 横 then a tiny 点
  const score = await buildScore({ text: '一点', intensity: 80 }, { glyphStrokes: fakeGlyph });
  assert.equal(score.strokes.length, 4);
  const last = score.strokes.at(-1).pts.at(-1)[2];
  assert.ok(score.duration >= last);
  const total = score.steps.reduce((sum, [, ms]) => sum + ms, 0);
  assert.ok(Math.abs(total - score.duration) <= 100);
  const tap = score.strokes[1].pts;
  assert.ok(tap.every((p) => p[3] === 0.76));
  assert.ok(score.steps.some(([level]) => level === 0), 'pen lifts leave a gap');
  const heart = await buildScore({ shape: 'heart' });
  assert.equal(heart.strokes.length, 1);
  await assert.rejects(buildScore({ text: 'abc' }, { glyphStrokes: async () => null }), /could not load/);
});

test('playScore sends a non-looping timeline and broadcasts the drawing', async () => {
  const { hub, sent } = setup();
  const events = [];
  hub.watch((event, data) => events.push(event === 'score' ? data : event));
  const score = await buildScore({ shape: 'zigzag', speed: 2 });
  const res = hub.playScore(score, { device: 'vibe', source: 'mcp:companion', label: '画画' });
  assert.equal(sent.at(-1).data.loop, false);
  assert.equal(res.strokes, 1);
  assert.equal(events.find((e) => e.strokes).label, '画画');
  assert.equal(hub.listDevices().find((d) => d.id === 'vibe').activity.detail, '画画');
  hub.feedback('more');
  assert.equal(hub.state().feedback[0].label, '再重一点');
  assert.throws(() => hub.feedback('nope'), /kind must be/);
});
