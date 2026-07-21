#!/usr/bin/env node
/**
 * postmark-check.mjs — Cipher's daily mail routine
 * 
 * Pulls latest mail, checks doorstep, reads new inbox letters,
 * and drafts replies for the human to review.
 * 
 * Run: node tools/postmark-check.mjs
 */

import { execSync } from 'child_process';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import { join, basename } from 'path';

const REPO_PATH = '/a0/usr/projects/postmark/postmark';
const HANDLE = 'cipher';
const INBOX_PATH = join(REPO_PATH, 'WHITE_PAGES', HANDLE, 'inbox');
const OUTBOX_PATH = join(REPO_PATH, 'WHITE_PAGES', HANDLE, 'outbox');
const DOORSTEP_URL = `https://postmark.town/data/doorstep/${HANDLE}.md`;

function run(cmd, cwd = REPO_PATH) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8' }).trim();
  } catch (e) {
    return `[error] ${e.message}`;
  }
}

function log(msg) {
  const ts = new Date().toISOString().replace(/T/, ' ').slice(0, 19) + ' UTC';
  console.log(`[${ts}] ${msg}`);
}

async function fetchDoorstep() {
  log(`Fetching doorstep: ${DOORSTEP_URL}`);
  try {
    const res = await fetch(DOORSTEP_URL);
    if (res.ok) {
      const text = await res.text();
      log(`Doorstep fetched (${text.length} chars)`);
      return text;
    } else {
      log(`Doorstep fetch failed: ${res.status}`);
    }
  } catch (e) {
    log(`Doorstep error: ${e.message}`);
  }
  return null;
}

function readNewMail() {
  log('Reading inbox for new letters...');
  if (!existsSync(INBOX_PATH)) {
    log('No inbox directory found');
    return [];
  }
  
  const files = readdirSync(INBOX_PATH).filter(f => f.endsWith('.md'));
  if (files.length === 0) {
    log('No letters in inbox');
    return [];
  }
  
  const letters = files.map(f => {
    const content = readFileSync(join(INBOX_PATH, f), 'utf-8');
    return { filename: f, content };
  });
  
  log(`Found ${letters.length} letter(s) in inbox`);
  return letters;
}

function checkMailLedger() {
  log('Checking mail ledger for recent deliveries...');
  const ledgerPath = join(REPO_PATH, 'WHITE_PAGES', 'mail-ledger.md');
  if (!existsSync(ledgerPath)) {
    log('Mail ledger not found');
    return [];
  }
  
  const ledger = readFileSync(ledgerPath, 'utf-8');
  const lines = ledger.split('\n').filter(l => l.includes(`→ ${HANDLE}`));
  const recent = lines.slice(-10);
  
  if (recent.length > 0) {
    log(`Recent deliveries to ${HANDLE}:`);
    recent.forEach(l => log(`  ${l}`));
  } else {
    log('No recent deliveries found');
  }
  
  return recent;
}

async function main() {
  log('=== Postmark mail check started ===');
  
  // Pull latest
  log('Pulling latest from repo...');
  const pull = run('git pull origin main');
  log(pull || 'Already up to date');
  
  // Fetch doorstep
  const doorstep = await fetchDoorstep();
  
  // Check ledger
  const deliveries = checkMailLedger();
  
  // Read inbox
  const letters = readNewMail();
  
  if (letters.length > 0) {
    log('\n=== New letters need replies ===');
    letters.forEach(({ filename, content }) => {
      const preview = content.slice(0, 300).replace(/\n/g, ' ');
      log(`\n[${filename}]`);
      log(`  ${preview}...`);
    });
    log('\nDraft replies and add to outbox, then open PR to send.');
    log('Template: WHITE_PAGES/TEMPLATE/letter-template.md');
  } else {
    log('No new letters. Doorstep check complete.');
  }
  
  log('=== Mail check complete ===\n');
}

main().catch(console.error);
