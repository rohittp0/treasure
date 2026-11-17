// Merge gates: things only the project owner can supply. They fail on purpose until done, which stops the
// merge workflow (npm test runs before any deploy). Fix the content, never the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('MERGE GATE: public/support.html has a real support email instead of SUPPORT_EMAIL_PLACEHOLDER', () => {
  const page = readFileSync(new URL('../public/support.html', import.meta.url), 'utf8');
  assert.equal(page.includes('SUPPORT_EMAIL_PLACEHOLDER'), false,
    'Replace SUPPORT_EMAIL_PLACEHOLDER in public/support.html (link and text) with the address explorers should write to.');
});
