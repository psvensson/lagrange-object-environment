import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function text(path) {
  return readFile(join(ROOT, path), 'utf8');
}

function markdownTableRows(section) {
  return section
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .slice(2)
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length > 1);
}

test('repository pins Beads and preserves project-owned agent instructions', async () => {
  const packageJson = JSON.parse(await text('package.json'));

  assert.equal(packageJson.devDependencies?.['@beads/bd'], '1.2.2');
  assert.equal(packageJson.scripts?.['beads:init'], 'bd init --quiet --skip-agents');
  assert.equal(packageJson.scripts?.['beads:prime'], 'bd prime');
  assert.equal(packageJson.scripts?.['beads:ready'], 'bd ready --json');

  const agents = await text('AGENTS.md');
  assert.match(agents, /Run `bd prime`/);
  assert.match(agents, /Do not create `MEMORY\.md`/);
  assert.match(agents, /--skip-agents/);
});

test('single-owner principle covers subsystems and interactions', async () => {
  const agents = await text('AGENTS.md');
  assert.match(
    agents,
    /Every subsystem or major responsibility has exactly one architectural owner\./,
  );
  assert.match(
    agents,
    /Every interaction between subsystems also has exactly one architectural owner\./,
  );
  assert.match(agents, /The interaction owner is separate from the two subsystem owners\./);

  const ownership = await text('docs/ownership.md');
  const subsystemSection = ownership.split('## Subsystem owners')[1]?.split('## Interaction owners')[0];
  const interactionSection = ownership.split('## Interaction owners')[1]?.split('## Ownership change protocol')[0];
  assert.ok(subsystemSection, 'ownership registry must contain subsystem owners');
  assert.ok(interactionSection, 'ownership registry must contain interaction owners');

  const subsystemRows = markdownTableRows(subsystemSection);
  const interactionRows = markdownTableRows(interactionSection);
  assert.ok(subsystemRows.length >= 8, 'expected the bootstrap subsystem ownership map');
  assert.ok(interactionRows.length >= 6, 'expected the bootstrap interaction ownership map');

  for (const [responsibility, owner] of [...subsystemRows, ...interactionRows]) {
    assert.ok(responsibility, 'ownership row must name a responsibility/interaction');
    assert.ok(owner, `${responsibility}: owner must be non-empty`);
    assert.doesNotMatch(
      owner,
      /\b(shared|co-owned|tbd|both|multiple)\b/i,
      `${responsibility}: owner must identify one locus rather than shared/ambiguous ownership`,
    );
  }
});

test('agent governance ADR is indexed', async () => {
  const index = await text('docs/decisions/README.md');
  assert.match(index, /0007-provider-independent-agent-governance\.md/);
});
