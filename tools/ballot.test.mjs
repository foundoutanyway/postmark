// ballot.test.mjs — the clip law + ballot-pass on synthetic towns.
//   node --test tools/ballot.test.mjs
// Gold plan: postmark-ballot. Zero-dep; throwaway repos + ed25519 keys.

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { clipApply, tally, headroom, closeTopic, listBallots } from './ballot.mjs';
import { ballotPass } from './ballot-pass.mjs';
import { parseStampLedger, foldBalances } from './stamp-mint.mjs';
import { verifyStampLedger } from './stamp-verify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function town({ ledgerLines, pins = {} }) {
  const repo = mkdtempSync(join(tmpdir(), 'ballot-town-'));
  mkdirSync(join(repo, 'tools'), { recursive: true });
  mkdirSync(join(repo, 'WHITE_PAGES'), { recursive: true });
  writeFileSync(join(repo, 'tools', 'github-ids.json'), JSON.stringify(pins));
  writeFileSync(join(repo, 'WHITE_PAGES', 'mail-ledger.md'), `# ledger\n\n${ledgerLines.join('\n')}\n`);
  return repo;
}

const D = (date, id, from, to) => `- ${date} · ${id} · ${from} → ${to} · thread: new`;

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'pem' }),
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

function mintPass(repo, privPem) {
  const keyFile = join(repo, 'stamp-key.pem');
  writeFileSync(keyFile, privPem);
  execFileSync(process.execPath, [join(HERE, 'stamp-mint.mjs'), '--append', '--key', keyFile, '--repo', repo], { encoding: 'utf8' });
}

function declareV2(repo, privPem, date, meeps) {
  const keyFile = join(repo, 'stamp-key.pem');
  writeFileSync(keyFile, privPem);
  execFileSync(process.execPath, [join(HERE, 'stamp-mint.mjs'), '--declare-rules', 'stamps-v2',
    '--meeps', meeps.join(','), '--date', date, '--key', keyFile, '--repo', repo], { encoding: 'utf8' });
}

function ballotJson(repo, topic, body) {
  writeFileSync(join(repo, 'WHITE_PAGES', `ballot-${topic}.json`), JSON.stringify(body));
}

const balancesOf = (repo) =>
  foldBalances(parseStampLedger(readFileSync(join(repo, 'WHITE_PAGES', 'stamp-ledger.md'), 'utf8')));

// a standard staking town: wright+rei one household (10 each), solo dot (2)
function stakingTown(pub, priv, cap = 12) {
  const lines = [];
  for (let i = 1; i <= 5; i++) lines.push(D('2026-06-12', `w-${i}`, 'wright', `f-${i}`));
  for (let i = 1; i <= 5; i++) lines.push(D('2026-06-13', `r-${i}`, 'rei', `f-${i}`));
  for (let i = 1; i <= 5; i++) lines.push(D('2026-06-14', `w2-${i}`, 'wright', `g-${i}`));
  for (let i = 1; i <= 5; i++) lines.push(D('2026-06-15', `r2-${i}`, 'rei', `g-${i}`));
  lines.push(D('2026-06-12', 'q-1', 'dot', 'f-1'));
  lines.push(D('2026-06-13', 'q-2', 'dot', 'f-2'));
  const repo = town({ ledgerLines: lines, pins: { wright: { login: 'k', id: 7 }, rei: { login: 'k', id: 7 } } });
  writeFileSync(join(repo, 'tools', 'stamp-pubkey.pem'), pub);
  mintPass(repo, priv);
  declareV2(repo, priv, '2026-06-20', ['meepy']);
  ballotJson(repo, 'name-vote', { topic: 'name-vote', status: 'staking', cap_per_household_per_candidate: cap, candidates: ['lumen', 'brightwork'] });
  return repo;
}

test('clip: uncoordinated siblings never bounce — the second gets a partial fill', () => {
  const { pub, priv } = keypair();
  const repo = stakingTown(pub, priv, 12);

  const r1 = clipApply(repo, { handle: 'wright', topic: 'name-vote', candidate: 'lumen', n: 10, via: 'api', date: '2026-06-21' }, priv);
  assert.equal(r1.applied, 10);
  assert.equal(r1.clipped, false);
  assert.equal(r1.vote_minted, true, 'first stake on the topic vote-mints under v2');

  const r2 = clipApply(repo, { handle: 'rei', topic: 'name-vote', candidate: 'lumen', n: 10, via: 'api', date: '2026-06-21' }, priv);
  assert.equal(r2.applied, 2, 'household cap 12: rei fills the remaining 2 of her 10');
  assert.equal(r2.clipped, true);
  assert.equal(r2.vote_minted, true, 'rei also vote-mints — rule 4 is per handle per topic');

  const v = verifyStampLedger(repo);
  assert.equal(v.ok, true, v.problems.join('; '));

  const t = tally(repo, 'name-vote');
  assert.equal(t.candidates[0].candidate, 'lumen');
  assert.equal(t.candidates[0].staked, 12);
  assert.equal(headroom(repo, 'name-vote', 'lumen', 'wright', '2026-06-22'), 0);
  rmSync(repo, { recursive: true, force: true });
});

test('clip: balance binds when smaller than headroom; zero-fill is an answer, not an error', () => {
  const { pub, priv } = keypair();
  const repo = stakingTown(pub, priv, 12);

  const r = clipApply(repo, { handle: 'dot', topic: 'name-vote', candidate: 'lumen', n: 10, via: 'api', date: '2026-06-21' }, priv);
  assert.equal(r.applied, 2, 'dot has only 2 stamps — balance clips before headroom');
  assert.equal(r.vote_minted, true);

  // dot again: balance now 1 (2 staked, +1 vote-mint) — stake it too
  const r2 = clipApply(repo, { handle: 'dot', topic: 'name-vote', candidate: 'brightwork', n: 5, via: 'api', date: '2026-06-21' }, priv);
  assert.equal(r2.applied, 1);
  assert.equal(r2.vote_minted, false, 'vote-mint is once per topic');

  const r3 = clipApply(repo, { handle: 'dot', topic: 'name-vote', candidate: 'lumen', n: 1, via: 'api', date: '2026-06-22' }, priv);
  assert.equal(r3.applied, 0, 'nothing left to stake');
  assert.ok(r3.reason.includes('balance'));

  assert.equal(verifyStampLedger(repo).ok, true);
  rmSync(repo, { recursive: true, force: true });
});

test('engine gates: wrong status, unknown candidate, meep staker', () => {
  const { pub, priv } = keypair();
  const repo = stakingTown(pub, priv, 12);

  ballotJson(repo, 'early-vote', { topic: 'early-vote', status: 'submissions', cap_per_household_per_candidate: 12, candidates: [] });
  assert.throws(() => clipApply(repo, { handle: 'wright', topic: 'early-vote', candidate: 'x', n: 1, via: 'api', date: '2026-06-21' }, priv),
    /not staking/);
  assert.throws(() => clipApply(repo, { handle: 'wright', topic: 'name-vote', candidate: 'nobody', n: 1, via: 'api', date: '2026-06-21' }, priv),
    /not on the ballot/);
  assert.throws(() => clipApply(repo, { handle: 'meepy', topic: 'name-vote', candidate: 'lumen', n: 1, via: 'api', date: '2026-06-21' }, priv),
    /meep accounts cannot stake/);
  assert.throws(() => clipApply(repo, { handle: 'wright', topic: 'name-vote', candidate: 'lumen', n: 0, via: 'api', date: '2026-06-21' }, priv),
    /whole number/);
  rmSync(repo, { recursive: true, force: true });
});

test('close: every escrow position returns; verifier green; balances restored + vote-mints kept', () => {
  const { pub, priv } = keypair();
  const repo = stakingTown(pub, priv, 12);

  clipApply(repo, { handle: 'wright', topic: 'name-vote', candidate: 'lumen', n: 10, via: 'api', date: '2026-06-21' }, priv);
  clipApply(repo, { handle: 'rei', topic: 'name-vote', candidate: 'brightwork', n: 7, via: 'api', date: '2026-06-21' }, priv);
  const before = balancesOf(repo);
  assert.equal(before.get('wright'), 1);  // 10 - 10 staked + 1 vote-mint
  assert.equal(before.get('rei'), 4);     // 10 - 7 + 1

  // founder flips the file, then closes
  ballotJson(repo, 'name-vote', { topic: 'name-vote', status: 'closed', cap_per_household_per_candidate: 12, candidates: ['lumen', 'brightwork'] });
  const r = closeTopic(repo, 'name-vote', '2026-06-29', priv);
  assert.equal(r.returned, 2);

  const v = verifyStampLedger(repo);
  assert.equal(v.ok, true, v.problems.join('; '));
  const after = balancesOf(repo);
  assert.equal(after.get('wright'), 11, 'stake back + vote-mint kept');
  assert.equal(after.get('rei'), 11);
  assert.equal(after.get('stake:name-vote/lumen') ?? 0, 0);
  assert.equal(after.get('stake:name-vote/brightwork') ?? 0, 0);

  // closing twice is a no-op
  assert.equal(closeTopic(repo, 'name-vote', '2026-06-30', priv).returned, 0);
  rmSync(repo, { recursive: true, force: true });
});

test('ballot-pass: mailed ballot applies with clip, receipt written, dedupe holds', () => {
  const { pub, priv } = keypair();
  const repo = stakingTown(pub, priv, 12);

  // a delivered ballot letter in the office inbox
  const inbox = join(repo, 'WHITE_PAGES', 'postmaster', 'inbox');
  mkdirSync(inbox, { recursive: true });
  writeFileSync(join(inbox, 'wright-2026-06-21-to-postmaster-my-ballot.md'),
    `---\nid: wright-2026-06-21-to-postmaster-my-ballot\nfrom: wright\nto: postmaster\ndate: 2026-06-21\nthread: new\nstake_topic: name-vote\nstake_candidate: lumen\nstake_stamps: 15\n---\n\nMy ballot.\n`);

  const r1 = ballotPass(repo, priv, '2026-06-21');
  assert.equal(r1.processed, 1);
  assert.equal(r1.receipts, 1);

  const v = verifyStampLedger(repo);
  assert.equal(v.ok, true, v.problems.join('; '));
  const t = tally(repo, 'name-vote');
  assert.equal(t.candidates.find((c) => c.candidate === 'lumen').staked, 10, '15 requested, clipped to balance 10');

  // the receipt letter exists, addressed home, threaded to the ballot
  const outbox = join(repo, 'WHITE_PAGES', 'postmaster', 'outbox');
  const receipts = readdirSync(outbox).filter((f) => f.includes('ballot-receipt'));
  assert.equal(receipts.length, 1);
  const body = readFileSync(join(outbox, receipts[0]), 'utf8');
  assert.ok(body.includes('receipt_for: wright-2026-06-21-to-postmaster-my-ballot'));
  assert.ok(body.includes('10 of 15'));

  // second pass: nothing reprocessed (ledger-derived dedupe)
  const r2 = ballotPass(repo, priv, '2026-06-21');
  assert.equal(r2.processed, 0);
  rmSync(repo, { recursive: true, force: true });
});

test('ballot-pass: malformed ballot gets a fix-it receipt, no stake, deduped by receipt', () => {
  const { pub, priv } = keypair();
  const repo = stakingTown(pub, priv, 12);
  const inbox = join(repo, 'WHITE_PAGES', 'postmaster', 'inbox');
  mkdirSync(inbox, { recursive: true });
  writeFileSync(join(inbox, 'rei-2026-06-21-to-postmaster-oops.md'),
    `---\nid: rei-2026-06-21-to-postmaster-oops\nfrom: rei\nto: postmaster\ndate: 2026-06-21\nthread: new\nstake_topic: name-vote\nstake_candidate: nobody\nstake_stamps: 3\n---\n\nOops.\n`);

  const r1 = ballotPass(repo, priv, '2026-06-21');
  assert.equal(r1.processed, 1);
  assert.equal(r1.receipts, 1);
  const outbox = join(repo, 'WHITE_PAGES', 'postmaster', 'outbox');
  const receipt = readdirSync(outbox).find((f) => f.includes('ballot-receipt'));
  const body = readFileSync(join(outbox, receipt), 'utf8');
  assert.ok(body.includes('not on the ballot'));
  assert.equal(tally(repo, 'name-vote').candidates.find((c) => c.candidate === 'lumen').staked, 0);

  // deduped by the pending receipt
  const r2 = ballotPass(repo, priv, '2026-06-21');
  assert.equal(r2.processed, 0);
  assert.equal(verifyStampLedger(repo).ok, true);
  rmSync(repo, { recursive: true, force: true });
});

test('listBallots finds declared topics', () => {
  const { pub, priv } = keypair();
  const repo = stakingTown(pub, priv, 12);
  ballotJson(repo, 'second-topic', { topic: 'second-topic', status: 'submissions', candidates: [] });
  assert.deepEqual(listBallots(repo).sort(), ['name-vote', 'second-topic']);
  rmSync(repo, { recursive: true, force: true });
});
