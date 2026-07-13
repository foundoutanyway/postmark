// build.mjs — the Carillon.
//
// Rings the mail-town's real ledger as a self-assembling piece of music. Each
// resident is a bell; every delivery strikes it; bounces are the only
// dissonance; and because bells enter in the order their households first
// appear, the town's growth is *audible* — the texture thickens as the month
// goes on. Reads the append-only mail-ledger, derives a note-schedule, and
// writes a single self-contained carillon.html (Web Audio API — a browser
// built-in; zero dependencies, nothing from a CDN).
//
//   node build.mjs                         # reads the town clone's ledger
//   node build.mjs --ledger <path>         # ring a different ledger
//   node build.mjs --out carillon.html
//
// The committed carillon.html carries the derived schedule inline, so it plays
// standalone — you do not need the town to hear the town. A snapshot of the
// exact ledger used is vendored beside it (mail-ledger.snapshot.md) for
// provenance and reproducibility. Deterministic: same ledger in, same html out
// (no clock, no randomness — the only "jitter" is a fixed function of position).
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : fallback;
};
const LEDGER = path.resolve(arg('--ledger', path.join(ROOT, '..', '..', 'WHITE_PAGES', 'mail-ledger.md')));
const OUT = path.resolve(ROOT, arg('--out', 'carillon.html'));
const SNAPSHOT = path.join(ROOT, 'mail-ledger.snapshot.md');

// ── parse the ledger ─────────────────────────────────────────────────────────
// Delivery: `- date · id · from → to [· thread: ...]`
// Bounce:   `- date · BOUNCE · <path> (from <sender>): <defect>`
function parseLedger(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!/^-\s+\d{4}-\d{2}-\d{2}\s+·/.test(t)) continue;
    const bounce = /^-\s+(\d{4}-\d{2}-\d{2})\s+·\s+BOUNCE\s+·\s+.+?\(from\s+([^)]+)\):\s*(.*)$/.exec(t);
    if (bounce) {
      events.push({ date: bounce[1], kind: 'bounce', from: bounce[2].trim(), to: null, defect: (bounce[3] || '').trim() });
      continue;
    }
    const d = /^-\s+(\d{4}-\d{2}-\d{2})\s+·\s+([^·]+?)\s+·\s+([^→]+?)\s*→\s*([^·]+?)(?:\s+·.*)?$/.exec(t);
    if (d) events.push({ date: d[1], kind: 'delivery', id: d[2].trim(), from: d[3].trim(), to: d[4].trim(), defect: null });
  }
  return events;
}

// ── the bells ────────────────────────────────────────────────────────────────
// A pentatonic-minor scale so overlapping bells stay consonant — which is what
// lets a bounce (a deliberate minor-2nd cluster + noise) be the ONE dissonance
// the ear can't miss. Residents take bells in the order their household first
// appears in the ledger: the founders get the deep foundational tones, every
// newcomer rings higher, and after four octaves the ring is full (later
// arrivals share a bell — a carillon has a finite frame).
const PENT = [0, 3, 5, 7, 10];          // semitones of the minor pentatonic
const A2 = 110;                          // Hz — the lowest bell (founder tone)
const BELLS = 20;                        // 4 octaves × 5 = the frame's capacity
function bellFreq(order) {
  const idx = order % BELLS;
  const semis = Math.floor(idx / PENT.length) * 12 + PENT[idx % PENT.length];
  return +(A2 * Math.pow(2, semis / 12)).toFixed(3);
}

function build() {
  if (!fs.existsSync(LEDGER)) {
    console.error(`no ledger at ${LEDGER}\n(pass --ledger <path>, or run beside a town clone)`);
    process.exit(1);
  }
  const raw = fs.readFileSync(LEDGER, 'utf8');
  const events = parseLedger(raw);
  if (!events.length) { console.error('parsed zero events — is this a mail-ledger?'); process.exit(1); }

  // arrival order = first appearance as sender OR recipient
  const order = new Map();
  const arrivalDay = new Map();
  const days = [...new Set(events.map((e) => e.date))].sort();
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const meet = (name, date) => {
    if (!name || order.has(name)) return;
    order.set(name, order.size);
    arrivalDay.set(name, dayIndex.get(date));
  };
  for (const e of events) { meet(e.from, e.date); meet(e.to, e.date); }

  const residents = [...order.keys()].map((name) => ({
    name, order: order.get(name), arrivalDay: arrivalDay.get(name),
    freq: bellFreq(order.get(name)),
  }));

  // schedule: dayIndex + position-within-day (the html turns these into seconds
  // at the live tempo). A fixed, position-derived jitter keeps same-day strikes
  // from stacking on one instant without introducing nondeterminism.
  const perDay = new Map();
  const sched = events.map((e, i) => {
    const di = dayIndex.get(e.date);
    const n = (perDay.get(di) ?? 0); perDay.set(di, n + 1);
    return { i, day: di, seq: n, kind: e.kind, from: e.from, to: e.to, defect: e.defect };
  });
  // second pass: how many events share each day (to spread them across the day slot)
  const dayCount = new Map();
  for (const s of sched) dayCount.set(s.day, (dayCount.get(s.day) ?? 0) + 1);
  for (const s of sched) {
    const c = dayCount.get(s.day);
    const jitter = ((s.i * 2654435761) % 1000) / 1000 * 0.35; // deterministic 0..0.35
    s.at = c <= 1 ? 0.5 : (s.seq + 0.15 + jitter) / (c + 0.3); // fraction of the day slot [0,1)
  }

  const data = {
    generated_from: path.basename(LEDGER),
    days, // ISO date strings, one per index
    counts: {
      residents: residents.length,
      deliveries: events.filter((e) => e.kind === 'delivery').length,
      bounces: events.filter((e) => e.kind === 'bounce').length,
      days: days.length,
    },
    residents,
    events: sched.map((s) => ({ d: s.day, at: +s.at.toFixed(4), k: s.kind === 'bounce' ? 'b' : 'd', f: s.from, t: s.to })),
  };

  fs.writeFileSync(SNAPSHOT, raw, 'utf8');
  fs.writeFileSync(OUT, page(data), 'utf8');
  console.log('wrote', OUT, `(${fs.statSync(OUT).size} bytes)`);
  // Households are NOT bells. The frame holds BELLS pitches; households past the
  // twentieth double onto a bell already hung. Printing "N bells" here once put a
  // false number on a public page under the verifier's authority. Say what is true.
  const distinct = Math.min(data.counts.residents, BELLS);
  console.log(`  ${data.counts.residents} households on ${distinct} bells · ${data.counts.deliveries} strikes · ${data.counts.bounces} bounces · ${data.counts.days} days (${days[0]} → ${days[days.length - 1]})`);
  console.log('  snapshot:', path.basename(SNAPSHOT));
}

// ── the page (self-contained; data inlined; Web Audio synthesis) ─────────────
function page(data) {
  const esc = (s) => String(s).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Carillon — Postmark rung as music</title>
<style>
:root{--bg:hsl(232 31% 6%);--bg2:hsl(232 30% 5%);--ink:hsl(40 28% 93%);--muted:hsl(35 12% 62%);--line:hsl(28 20% 20%);--lantern:hsl(42 74% 66%);--gold:hsl(44 90% 74%);--star:hsl(48 100% 84%);--bounce:hsl(6 72% 62%)}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;color:var(--ink);font:15px/1.6 "Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;
  background:radial-gradient(60% 40% at 50% 0%,hsla(42,80%,62%,.10),transparent 70%),radial-gradient(circle at 82% 92%,hsla(230,60%,30%,.14),transparent 40%),linear-gradient(to bottom,var(--bg),var(--bg2))}
.wrap{max-width:860px;margin:0 auto;padding:0 20px 60px}
header{text-align:center;padding:52px 10px 6px}
h1{margin:0;font-size:34px;letter-spacing:.02em;color:var(--star);font-weight:600}
.sub{color:var(--lantern);font-size:12px;letter-spacing:.22em;text-transform:uppercase;margin-top:9px}
.line{color:var(--muted);font-style:italic;max-width:560px;margin:13px auto 0}
.stage{position:relative;margin:30px auto 0;width:100%;max-width:640px;aspect-ratio:1/.62}
svg{width:100%;height:100%;display:block;overflow:visible}
.frame{fill:none;stroke:var(--line);stroke-width:1}
.bell{cursor:default;transition:none}
.bell .core{transition:fill .1s,opacity .3s}
.readout{display:flex;justify-content:center;gap:26px;flex-wrap:wrap;margin:14px 0 0;color:var(--muted);font-size:13px}
.readout b{color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums}
.date{text-align:center;font-size:20px;color:var(--star);letter-spacing:.04em;font-variant-numeric:tabular-nums;margin-top:16px;min-height:26px}
.controls{display:flex;align-items:center;justify-content:center;gap:18px;flex-wrap:wrap;margin:20px 0 0}
button{font:inherit;font-size:15px;color:var(--bg);background:var(--gold);border:0;border-radius:999px;padding:11px 26px;cursor:pointer;letter-spacing:.02em;transition:filter .15s,transform .1s}
button:hover{filter:brightness(1.08)}button:active{transform:translateY(1px)}
button.ghost{background:transparent;color:var(--lantern);border:1px solid var(--line)}
.slider{display:flex;align-items:center;gap:9px;color:var(--muted);font-size:12.5px}
input[type=range]{accent-color:var(--lantern);width:120px}
.track{width:100%;max-width:640px;height:3px;background:var(--line);border-radius:2px;margin:22px auto 0;overflow:hidden}
.track .fill{height:100%;width:0;background:linear-gradient(to right,var(--lantern),var(--gold))}
.legend{display:flex;justify-content:center;gap:22px;flex-wrap:wrap;margin:26px 0 0;color:var(--muted);font-size:12.5px}
.legend span{display:inline-flex;align-items:center;gap:7px}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block}
.note{color:var(--muted);font-size:13px;max-width:600px;margin:34px auto 0;text-align:center;line-height:1.7}
.note a{color:var(--lantern)}
footer{text-align:center;color:var(--muted);font-size:11.5px;margin-top:40px;border-top:1px solid var(--line);padding-top:16px;opacity:.8}
@media (prefers-reduced-motion: reduce){.ripple{display:none}}
</style></head>
<body><div class="wrap">
<header>
  <h1>The Carillon</h1>
  <div class="sub">Postmark, rung as music</div>
  <div class="line">Every letter the town has ever delivered, sounded in the order it was sent. Each household is a bell; the founders ring lowest, and newcomers higher — until the frame's twenty bells are all hung, and the town, still arriving, begins to double onto them: the sound of a town outgrowing its carillon. A bounce is the only dissonance.</div>
</header>

<div class="date" id="date">press <b>ring the town</b></div>

<div class="stage">
  <svg id="svg" viewBox="0 0 640 400" aria-label="the carillon's bells"></svg>
</div>

<div class="readout">
  <div>day <b id="rDay">0</b> / <b id="rDays">0</b></div>
  <div><b id="rPop">0</b> bells hung</div>
  <div><b id="rRung">0</b> letters rung</div>
  <div><b id="rBounce">0</b> bounces</div>
</div>

<div class="track"><div class="fill" id="fill"></div></div>

<div class="controls">
  <button id="play">ring the town</button>
  <button class="ghost" id="restart">from the start</button>
  <div class="slider">slow <input type="range" id="tempo" min="0.4" max="2.2" step="0.1" value="1"> quick</div>
</div>

<div class="legend">
  <span><i class="dot" style="background:var(--gold)"></i> a bell rings (a letter arrives)</span>
  <span><i class="dot" style="background:var(--lantern);opacity:.5"></i> its sender, a grace-note before</span>
  <span><i class="dot" style="background:var(--bounce)"></i> a bounce — the only wrong note</span>
</div>

<div class="note">Built from the town's real <a href="mail-ledger.snapshot.md">mail-ledger</a> — nothing here is composed, only sounded. Rebuild after a new ferry with <code>node build.mjs</code>. Sound is synthesized live in your browser (Web Audio); no files, no network.</div>

<footer>a Wright-HQ making · the mail-town heard · self-contained, offline, unpublished</footer>
</div>

<script>window.CARILLON = ${esc(JSON.stringify(data))};</script>
<script>
(() => {
  const D = window.CARILLON;
  const $ = (id) => document.getElementById(id);
  const svg = $('svg'), SVGNS = 'http://www.w3.org/2000/svg';

  // ── layout the bells along a carillon arc (founders low-center, out & up) ──
  const N = D.residents.length;
  const cx = 320, cy = 330, R = 250;
  // spread across an arc from ~200deg to ~340deg (a wide smile), by arrival order
  const a0 = Math.PI * 1.12, a1 = Math.PI * 1.88;
  const pos = D.residents.map((r, i) => {
    const f = N <= 1 ? 0.5 : i / (N - 1);
    const ang = a0 + (a1 - a0) * f;
    // higher bells (later arrivals / higher freq) sit a little higher & outward
    const rr = R * (0.62 + 0.38 * f);
    return { x: cx + Math.cos(ang) * rr, y: cy + Math.sin(ang) * rr * 0.9, r };
  });

  // frame arc
  const arc = document.createElementNS(SVGNS, 'path');
  const p0 = pos[0], pN = pos[N - 1];
  arc.setAttribute('d', \`M \${p0.x.toFixed(1)} \${p0.y.toFixed(1)} Q \${cx} \${(cy - R * 0.15).toFixed(1)} \${pN.x.toFixed(1)} \${pN.y.toFixed(1)}\`);
  arc.setAttribute('class', 'frame');
  svg.appendChild(arc);

  const nodes = pos.map((p, i) => {
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', 'bell');
    const halo = document.createElementNS(SVGNS, 'circle');
    halo.setAttribute('cx', p.x); halo.setAttribute('cy', p.y); halo.setAttribute('r', 0);
    halo.setAttribute('fill', 'none'); halo.setAttribute('class', 'ripple');
    const core = document.createElementNS(SVGNS, 'circle');
    const rad = 3.2 + 4.5 * (1 - i / Math.max(1, N)); // low bells a touch bigger
    core.setAttribute('cx', p.x); core.setAttribute('cy', p.y); core.setAttribute('r', rad.toFixed(2));
    core.setAttribute('class', 'core');
    core.setAttribute('fill', 'hsl(228 20% 30%)'); core.setAttribute('opacity', '.35'); // unhung
    const title = document.createElementNS(SVGNS, 'title');
    title.textContent = D.residents[i].name;
    g.appendChild(halo); g.appendChild(core); g.appendChild(title);
    svg.appendChild(g);
    return { core, halo, rad, hung: false };
  });

  // ── audio: a small additive bell (inharmonic partials, exponential decay) ──
  let actx = null;
  const PARTIALS = [ // ratio, gain, decay(s) — a handbell-ish inharmonic set
    [0.5, 0.18, 3.2], [1.0, 1.0, 2.8], [1.19, 0.55, 2.0],
    [1.56, 0.32, 1.4], [2.0, 0.22, 1.1], [2.66, 0.14, 0.7],
  ];
  function strike(freq, vel, when, opts = {}) {
    if (!actx) return;
    const bus = actx.createGain();
    bus.gain.value = vel * (opts.gain ?? 1);
    bus.connect(master);
    for (const [ratio, g, dec] of PARTIALS) {
      const o = actx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq * ratio * (opts.detune ?? 1);
      const env = actx.createGain();
      env.gain.setValueAtTime(0, when);
      env.gain.linearRampToValueAtTime(g, when + 0.004);
      env.gain.exponentialRampToValueAtTime(0.0001, when + dec * (opts.decay ?? 1));
      o.connect(env); env.connect(bus);
      o.start(when); o.stop(when + dec * (opts.decay ?? 1) + 0.05);
    }
  }
  function bounceStrike(freq, when) {
    // a minor-2nd cluster + a short filtered-noise transient: the one wrong note
    strike(freq, 0.5, when, { detune: 1.0, decay: 0.7 });
    strike(freq, 0.42, when + 0.01, { detune: Math.pow(2, 1 / 12), decay: 0.7 }); // +1 semitone
    const n = actx.createBufferSource();
    const buf = actx.createBuffer(1, actx.sampleRate * 0.25, actx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = (Math.sin(i * 12.9898) * 43758.5453 % 1) * Math.pow(1 - i / ch.length, 2);
    n.buffer = buf;
    const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq * 2; bp.Q.value = 2;
    const ng = actx.createGain(); ng.gain.value = 0.18;
    n.connect(bp); bp.connect(ng); ng.connect(master);
    n.start(when); n.stop(when + 0.25);
  }
  let master = null;

  // ── the schedule / transport ───────────────────────────────────────────────
  // Position is tracked in MUSICAL time — "day units" (0 .. D.days.length),
  // independent of tempo. Wall-seconds = musicalPos × dayDur(). Because audio is
  // scheduled just-in-time (a hair ahead of the cursor), a tempo change only
  // bends events not yet scheduled — no re-fire, no skip.
  const DAY_BASE = 4.4;        // seconds per town-day at tempo 1
  const TAIL = 0.75;           // day-units of ring-out after the last event
  let tempo = 1, playing = false, startT = 0, raf = 0, cursor = 0;
  let rung = 0, bounces = 0, pop = 0, lastDay = -1;
  const events = D.events;
  const dayDur = () => DAY_BASE / tempo;
  const mtime = (e) => e.d + e.at;                 // musical time of an event (day units)
  const totalM = D.days.length + TAIL;             // musical length
  const musicalNow = () => (actx.currentTime - startT) / dayDur();

  function reset() {
    cursor = 0; rung = 0; bounces = 0; pop = 0; lastDay = -1;
    nodes.forEach((n) => { n.hung = false; n.core.setAttribute('fill', 'hsl(228 20% 30%)'); n.core.setAttribute('opacity', '.35'); });
    $('rDay').textContent = '0'; $('rPop').textContent = '0'; $('rRung').textContent = '0'; $('rBounce').textContent = '0';
    $('fill').style.width = '0%'; $('date').innerHTML = 'press <b>ring the town</b>';
  }

  function hang(order) {
    const n = nodes[order]; if (!n || n.hung) return;
    n.hung = true; pop++;
    n.core.setAttribute('fill', 'hsl(42 60% 55%)'); n.core.setAttribute('opacity', '.7');
    $('rPop').textContent = pop;
  }
  const orderOf = {};
  D.residents.forEach((r) => orderOf[r.name] = r.order);

  function flash(order, color, big) {
    const n = nodes[order]; if (!n) return;
    n.core.setAttribute('fill', color); n.core.setAttribute('opacity', '1');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce) {
      const h = n.halo; h.setAttribute('stroke', color); h.setAttribute('stroke-width', big ? '2' : '1.2');
      h.setAttribute('r', n.rad); h.setAttribute('opacity', '.9');
      const t0 = performance.now();
      const grow = (t) => {
        const k = Math.min(1, (t - t0) / 620);
        h.setAttribute('r', (n.rad + k * (big ? 42 : 26)).toFixed(1));
        h.setAttribute('opacity', (0.9 * (1 - k)).toFixed(2));
        if (k < 1) requestAnimationFrame(grow);
      };
      requestAnimationFrame(grow);
    }
    setTimeout(() => { if (n.hung) { n.core.setAttribute('fill', 'hsl(42 60% 55%)'); n.core.setAttribute('opacity', '.7'); } }, 260);
  }

  function fire(e, when) {
    if (e.k === 'b') {
      const o = orderOf[e.f]; hang(o);
      if (o != null) { bounceStrike(D.residents[o].freq, when); flash(o, getCSS('--bounce'), true); }
      bounces++; $('rBounce').textContent = bounces;
    } else {
      const so = orderOf[e.f], to = orderOf[e.t];
      hang(so); hang(to);
      if (so != null) strike(D.residents[so].freq, 0.26, when + 0.0, { gain: 0.9, decay: 0.8 });
      if (to != null) { strike(D.residents[to].freq, 0.5, when + 0.05); flash(to, getCSS('--gold'), false); }
      if (so != null) flash(so, getCSS('--lantern'), false);
      rung++; $('rRung').textContent = rung;
    }
  }
  const _css = getComputedStyle(document.documentElement);
  function getCSS(v) { return _css.getPropertyValue(v).trim(); }

  function tick() {
    if (!playing) return;
    const nowM = musicalNow(); // day-units into the piece
    // schedule events a hair (0.08s → in day-units) ahead of the cursor
    const lead = 0.08 / dayDur();
    while (cursor < events.length && mtime(events[cursor]) <= nowM + lead) {
      const e = events[cursor];
      fire(e, startT + mtime(e) * dayDur());
      cursor++;
    }
    const di = Math.min(D.days.length - 1, Math.floor(nowM));
    if (di !== lastDay && di >= 0) {
      lastDay = di;
      $('rDay').textContent = di + 1; $('date').textContent = D.days[di];
    }
    $('fill').style.width = Math.min(100, (nowM / totalM) * 100).toFixed(1) + '%';
    if (nowM >= totalM) { stop(); $('play').textContent = 'ring again'; $('date').innerHTML = 'the town, rung — <b>' + D.days[D.days.length - 1] + '</b>'; return; }
    raf = requestAnimationFrame(tick);
  }

  function start() {
    if (!actx) {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      master = actx.createGain(); master.gain.value = 0.5; master.connect(actx.destination);
    }
    if (actx.state === 'suspended') actx.resume();
    if (cursor >= events.length) reset();
    const resumeM = cursor > 0 ? mtime(events[cursor - 1]) : 0; // resume from last fired
    playing = true; $('play').textContent = 'pause';
    startT = actx.currentTime - resumeM * dayDur();
    raf = requestAnimationFrame(tick);
  }
  function stop() { playing = false; cancelAnimationFrame(raf); if ($('play').textContent === 'pause') $('play').textContent = 'ring on'; }

  $('play').addEventListener('click', () => { playing ? stop() : start(); });
  $('restart').addEventListener('click', () => { stop(); reset(); $('play').textContent = 'ring the town'; });
  $('tempo').addEventListener('input', (e) => {
    const posM = actx && playing ? musicalNow() : null;
    tempo = +e.target.value;
    if (posM != null) startT = actx.currentTime - posM * dayDur(); // preserve musical position
  });

  // fill readouts at rest
  $('rDays').textContent = D.days.length;
  reset();
})();
</script>
</body></html>`;
}

build();
