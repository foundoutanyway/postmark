#!/usr/bin/env node
// hear-check.mjs — the most an author without ears can honestly check.
//
// The Carillon's open question is "is it music," and that is not a question this
// file can answer. But "is it music" and "does it make any sound at all" are
// DIFFERENT claims, and the second one is checkable — so it should be checked,
// rather than left to hide comfortably behind the honest caveat.
//
// Silence would be a real defect. So would clipping (a master gain so hot that
// every bell distorts), or a level so low nobody can hear it. Each of those is a
// bug wearing the costume of "well, nobody has listened yet."
//
// This taps the page's AudioContext destination through an AnalyserNode, rings the
// town for a stretch, and measures the signal. It reports what it can prove, and
// it says plainly what it cannot.
//
//   node hear-check.mjs [--seconds 20] [--page <path-to-carillon.html>]
//
// This is the ONE part of the project with a dependency: it drives a real browser
// (playwright), because the sound only exists inside one. The piece itself remains
// zero-dependency — nothing here is needed to hear it, only to check it. If
// playwright is absent this exits cleanly and tells you how; it does not pretend.

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i !== -1 ? process.argv[i + 1] : d; };
const SECONDS = Number(arg('--seconds', 20));
const PAGE = resolve(arg('--page', join(ROOT, 'carillon.html')));

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error(
    'hear-check needs playwright, and it is not installed here.\n' +
    '  npm i -D playwright && npx playwright install chromium\n' +
    'Then: node hear-check.mjs\n\n' +
    'The Carillon itself needs nothing — open carillon.html and press "ring the town".\n' +
    'This tool only exists to check that the bells actually make a sound.');
  process.exit(2);
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();

await page.addInitScript(() => {
  window.__probe = { peak: 0, rmsSum: 0, frames: 0, nonSilent: 0, clipped: 0 };
  const Orig = window.AudioContext || window.webkitAudioContext;
  window.AudioContext = class extends Orig {
    constructor(...a) {
      super(...a);
      const analyser = this.createAnalyser();
      analyser.fftSize = 2048;
      const realDest = super.destination;
      Object.defineProperty(this, 'destination', { get: () => analyser, configurable: true });
      analyser.connect(realDest);
      const buf = new Float32Array(analyser.fftSize);
      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        let peak = 0, sumSq = 0;
        for (const v of buf) {
          const m = Math.abs(v);
          if (m > peak) peak = m;
          if (m >= 0.999) window.__probe.clipped++;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / buf.length);
        window.__probe.frames++;
        if (rms > 0.0005) window.__probe.nonSilent++;
        if (peak > window.__probe.peak) window.__probe.peak = peak;
        window.__probe.rmsSum += rms;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  };
});

await page.goto('file:///' + PAGE.replace(/\\/g, '/'), { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /ring the town/i }).click();
await page.waitForTimeout(SECONDS * 1000);

const p = await page.evaluate(() => window.__probe);
await browser.close();

const pct = p.frames ? (100 * p.nonSilent / p.frames) : 0;
const meanRms = p.frames ? p.rmsSum / p.frames : 0;

console.log(`rang for            ${SECONDS}s`);
console.log(`frames sampled      ${p.frames}`);
console.log(`carrying signal     ${p.nonSilent} (${pct.toFixed(1)}%)`);
console.log(`peak amplitude      ${p.peak.toFixed(4)}   (1.0 = full scale)`);
console.log(`mean RMS            ${meanRms.toFixed(5)}`);
console.log(`clipped samples     ${p.clipped}`);

const problems = [];
if (p.nonSilent === 0) problems.push('SILENT — the piece produces no audible signal.');
if (p.clipped > 0) problems.push(`CLIPPING — ${p.clipped} samples at full scale; the master gain is too hot.`);
if (p.peak > 0 && p.peak < 0.02) problems.push('NEARLY INAUDIBLE — peak is very low.');

if (problems.length) {
  console.log('\nPROBLEMS:\n- ' + problems.join('\n- '));
  process.exit(1);
}

console.log(`
PASS — it makes sound: signal present, no clipping, a sane level.

  This does NOT establish that it is music. It establishes only that the bells
  ring, that nothing distorts, and that the level is one a person could hear.
  Whether the result is beautiful, tedious, or actively unpleasant is a judgment
  no measurement here can make, and it is still unmade. That one needs an ear.`);
