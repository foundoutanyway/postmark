// verify.mjs — proves the Carillon's deterministic core without a browser.
// Re-derives what the ledger should yield and checks the generated html's
// inlined data against it, plus a syntax-parse of the page's two scripts.
//   node verify.mjs
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';

const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(ROOT, 'carillon.html'), 'utf8');
const ledger = fs.readFileSync(path.join(ROOT, 'mail-ledger.snapshot.md'), 'utf8');

let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fails++; };

// pull the inlined data
const m = /window\.CARILLON = (\{.*?\});<\/script>/s.exec(html);
ok(!!m, 'carillon.html carries an inlined CARILLON data block');
const data = JSON.parse(m[1]);

// re-derive expected counts from the snapshot ledger
// anchor on the date prefix so the ledger's own format-doc lines
// (`- Bounce line: \`date · BOUNCE · ...\``) are not miscounted as events
const lines = ledger.split(/\r?\n/).map((l) => l.trim());
const isEvent = (l) => /^-\s+\d{4}-\d{2}-\d{2}\s+·/.test(l);
const deliv = lines.filter((l) => isEvent(l) && !/·\s+BOUNCE\s+·/.test(l)).length;
const bounce = lines.filter((l) => isEvent(l) && /·\s+BOUNCE\s+·/.test(l)).length;
ok(data.counts.deliveries === deliv, `deliveries match ledger (${data.counts.deliveries} === ${deliv})`);
ok(data.counts.bounces === bounce, `bounces match ledger (${data.counts.bounces} === ${bounce})`);
ok(data.events.length === deliv + bounce, `every ledger event is scheduled (${data.events.length})`);

// bells: pentatonic, founders lowest, strictly assigned by arrival order
const PENT = [0, 3, 5, 7, 10], A2 = 110, BELLS = 20;
const expFreq = (o) => { const i = o % BELLS; const s = Math.floor(i / 5) * 12 + PENT[i % 5]; return +(A2 * Math.pow(2, s / 12)).toFixed(3); };
let freqOK = true, orderOK = true;
data.residents.forEach((r, i) => {
  if (r.order !== i) orderOK = false;
  if (r.freq !== expFreq(r.order)) freqOK = false;
});
ok(orderOK, 'residents are indexed in arrival order');
ok(freqOK, 'every bell frequency is the pentatonic pitch for its arrival slot');
ok(data.residents[0].freq === 110, `the first founder rings the lowest bell (A2 = ${data.residents[0].freq}Hz)`);
// the reader-facing claim is "founders lowest, newcomers higher UNTIL the frame
// fills, then the town doubles onto hung bells" — assert BOTH halves, not the
// weak "some bell is higher" that a single arrival satisfies.
const frame = Math.min(data.residents.length, BELLS);
let ascOK = true;
for (let i = 1; i < frame; i++) if (!(data.residents[i].freq > data.residents[i - 1].freq)) ascOK = false;
ok(ascOK, `the first ${frame} bells ascend strictly (founders lowest → newcomers higher, until the frame fills)`);
if (data.residents.length > BELLS) {
  let wrapOK = true, example = null;
  for (let i = BELLS; i < data.residents.length; i++) {
    if (data.residents[i].freq !== data.residents[i % BELLS].freq) wrapOK = false;
    else if (!example) example = [data.residents[i].name, data.residents[i % BELLS].name, data.residents[i].freq];
  }
  ok(wrapOK, `beyond the ${BELLS}-bell frame, each newcomer doubles EXACTLY onto a hung bell` + (example ? ` (e.g. ${example[0]} rings ${example[1]}'s ${example[2]}Hz)` : ''));
} else {
  console.log(`  ~   all ${data.residents.length} residents fit inside the ${BELLS}-bell frame; no doubling yet`);
}

// referential integrity: every event names known residents
const names = new Set(data.residents.map((r) => r.name));
let refOK = true;
for (const e of data.events) {
  if (!names.has(e.f)) refOK = false;
  if (e.k === 'd' && !names.has(e.t)) refOK = false;
}
ok(refOK, 'every scheduled strike names a hung bell (no orphan senders/recipients)');

// timing: events are within their day slot, days are sorted + unique
ok(data.events.every((e) => e.at >= 0 && e.at < 1), 'every event sits inside its own day (at ∈ [0,1))');
ok(data.days.length === new Set(data.days).size, 'days are unique');
ok(data.days.every((d, i) => i === 0 || d > data.days[i - 1]), 'days are chronologically sorted');
ok(data.events.every((e) => e.d >= 0 && e.d < data.days.length), 'every event maps to a real day index');

// the growth arc: bells hang monotonically; the last day is denser than the first
const firstDay = data.events.filter((e) => e.d === 0).length;
const lastDay = data.events.filter((e) => e.d === data.days.length - 1).length;
ok(data.residents.every((r) => r.arrivalDay >= 0 && r.arrivalDay < data.days.length), 'every bell has a real arrival day');
console.log(`  ~   first day ${firstDay} events · last day ${lastDay} events · ${data.residents.length} households on ${new Set(data.residents.map((r) => r.freq)).size} bells`);

// both <script> blocks parse as JavaScript (syntax only; browser globals never run)
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((s) => s[1]);
ok(scripts.length === 2, 'the page has its two scripts (data + player)');
scripts.forEach((src, i) => {
  try { new vm.Script(src); ok(true, `script #${i + 1} parses as valid JavaScript`); }
  catch (e) { ok(false, `script #${i + 1} parses — ${e.message}`); }
});

console.log(fails ? `\n${fails} FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
