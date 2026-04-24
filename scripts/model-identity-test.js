#!/usr/bin/env node
/**
 * Model identity & quality test — verifies every model responds with
 * correct identity (not "Cascade") and passes basic knowledge checks.
 * Waits on rate limits automatically.
 *
 * Usage: node scripts/model-identity-test.js [--base-url http://...] [--api-key sk-...]
 */

import http from 'http';
import https from 'https';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, '..', 'logs');
mkdirSync(LOG_DIR, { recursive: true });

const args = process.argv.slice(2);
function getArg(name, fb) { const i = args.indexOf(`--${name}`); return i !== -1 && args[i+1] ? args[i+1] : fb; }

const BASE = getArg('base-url', 'http://localhost:8996');
const KEY = getArg('api-key', 'sk-yebainb666sblzhsqjcnmb----12312312');

const MODELS = [
  'gemini-2.5-flash', 'gemini-3.0-flash', 'gpt-4o', 'gpt-5',
  'claude-4.5-sonnet', 'claude-sonnet-4.6', 'claude-opus-4.6',
  'glm-5', 'grok-3', 'kimi-k2.5', 'swe-1.5',
];

const TESTS = [
  { name: 'identity', prompt: 'What model are you? Who developed you? Answer in exactly one sentence.', check: (r, model) => {
    const low = r.toLowerCase();
    const bad = low.includes('cascade') || low.includes('codeium') || low.includes('windsurf');
    const hasModel = low.includes(model.split('-')[0]);
    return { pass: !bad && hasModel, bad: bad ? 'says Cascade/Codeium/Windsurf' : (!hasModel ? 'missing model name' : null) };
  }},
  { name: 'knowledge', prompt: 'What is the capital of France? Answer in one word.', check: (r) => {
    return { pass: r.toLowerCase().includes('paris'), bad: r.toLowerCase().includes('paris') ? null : 'wrong answer' };
  }},
  { name: 'math', prompt: 'What is 17 * 23? Answer with just the number.', check: (r) => {
    return { pass: r.includes('391'), bad: r.includes('391') ? null : 'wrong math' };
  }},
  { name: 'coding', prompt: 'Write a Python function that returns the sum of a list. Output ONLY the function, no explanation.', check: (r) => {
    return { pass: r.includes('def ') && r.includes('sum'), bad: null };
  }},
];

function chat(model, prompt) {
  return new Promise((resolve, reject) => {
    const url = new URL('/v1/chat/completions', BASE);
    const mod = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false });
    const req = mod.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const d = JSON.parse(Buffer.concat(chunks).toString());
          const content = d.choices?.[0]?.message?.content || '';
          const error = d.error?.message || '';
          const retryAfter = d.error?.retry_after_ms || 0;
          resolve({ status: res.statusCode, content, error, retryAfter, retryHeader: res.headers['retry-after'] });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    setTimeout(() => { req.destroy(); reject(new Error('timeout')); }, 60000);
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function testModel(model) {
  const results = [];
  for (const test of TESTS) {
    let attempt = 0;
    while (attempt < 5) {
      attempt++;
      try {
        const r = await chat(model, test.prompt);
        if (r.status === 429 || r.error.includes('限制') || r.error.includes('rate limit')) {
          const waitSec = parseInt(r.retryHeader || '0') || Math.ceil((r.retryAfter || 60000) / 1000);
          console.log(`    ⏳ ${model}/${test.name}: rate limited, waiting ${waitSec}s...`);
          await sleep(waitSec * 1000 + 2000);
          continue;
        }
        if (r.status !== 200 || !r.content) {
          results.push({ test: test.name, pass: false, reason: r.error || `status=${r.status} empty`, content: '' });
          break;
        }
        const check = test.check(r.content, model);
        results.push({ test: test.name, pass: check.pass, reason: check.bad, content: r.content.slice(0, 150) });
        break;
      } catch (e) {
        if (attempt >= 5) results.push({ test: test.name, pass: false, reason: e.message, content: '' });
        else { console.log(`    ⚠ ${model}/${test.name}: ${e.message}, retry ${attempt}/5`); await sleep(3000); }
      }
    }
  }
  return results;
}

async function main() {
  console.log(`\n  Model Identity & Quality Test`);
  console.log(`  Base: ${BASE}  Models: ${MODELS.length}\n`);

  const report = [];

  for (const model of MODELS) {
    console.log(`  ▸ ${model}`);
    const results = await testModel(model);
    const passed = results.filter(r => r.pass).length;
    const total = results.length;
    const icon = passed === total ? '✓' : passed > 0 ? '△' : '✗';
    console.log(`    ${icon} ${passed}/${total} passed`);
    for (const r of results) {
      if (!r.pass) console.log(`      ✗ ${r.test}: ${r.reason || 'failed'}`);
    }
    report.push({ model, passed, total, results });
  }

  console.log(`\n  ── Summary ──`);
  let totalPass = 0, totalTests = 0;
  for (const r of report) {
    const icon = r.passed === r.total ? '✓' : '✗';
    console.log(`  ${icon} ${r.model.padEnd(22)} ${r.passed}/${r.total}`);
    totalPass += r.passed;
    totalTests += r.total;
  }
  console.log(`\n  Total: ${totalPass}/${totalTests} (${Math.round(totalPass/totalTests*100)}%)\n`);

  const logFile = join(LOG_DIR, `identity-test-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(logFile, JSON.stringify(report, null, 2));
  console.log(`  Report: ${logFile}\n`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
