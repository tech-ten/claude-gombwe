import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeSkillTool, type SkillToolLedger } from './skills.js';
import type { LedgerInput } from './ledger.js';
import type { SkillTool } from './types.js';

/** Collects what would have been written, so no data directory is needed. */
function fakeLedger(): SkillToolLedger & { written: LedgerInput[] } {
  const written: LedgerInput[] = [];
  return { written, record(input) { written.push(input); return input; } };
}

const dir = () => mkdtempSync(join(tmpdir(), 'gombwe-skills-'));

test('a shell tool records skill.<skill>.<tool> with the head of its output', async () => {
  const ledger = fakeLedger();
  const tool: SkillTool = { name: 'today', description: '', type: 'shell', command: 'echo bin night' };

  const output = await executeSkillTool(tool, dir(), ledger, { skillName: 'bins', principal: 'tendai' });

  assert.equal(output, 'bin night');
  assert.equal(ledger.written.length, 1);
  const entry = ledger.written[0];
  assert.equal(entry.action, 'skill.bins.today');
  assert.equal(entry.actor, 'skill');
  assert.equal(entry.principal, 'tendai');
  assert.equal(entry.target, 'today');
  assert.equal(entry.outcome, 'ok');
  assert.equal(entry.receipt?.outputHead, 'bin night');
});

test('a tool that fails is recorded as failed with the error', async () => {
  const ledger = fakeLedger();
  const tool: SkillTool = { name: 'broken', description: '', type: 'shell' };

  const output = await executeSkillTool(tool, dir(), ledger, { skillName: 'bins' });

  assert.match(output, /^Error:/);
  assert.equal(ledger.written[0].outcome, 'failed');
  assert.match(String(ledger.written[0].error), /no command specified/);
  // No principal given: a skill still runs at somebody's request.
  assert.equal(ledger.written[0].principal, 'owner');
});

test('without a ledger the tool still runs', async () => {
  const tool: SkillTool = { name: 'today', description: '', type: 'shell', command: 'echo hi' };
  assert.equal(await executeSkillTool(tool, dir()), 'hi');
});

test('a ledger that throws does not lose the output', async () => {
  const tool: SkillTool = { name: 'today', description: '', type: 'shell', command: 'echo hi' };
  const ledger: SkillToolLedger = { record() { throw new Error('disk full'); } };
  const original = console.error;
  const said: string[] = [];
  console.error = (...a: unknown[]) => { said.push(a.map(String).join(' ')); };
  try {
    assert.equal(await executeSkillTool(tool, dir(), ledger, { skillName: 'bins' }), 'hi');
  } finally {
    console.error = original;
  }
  assert.match(said.join('\n'), /could not record today/);
});
