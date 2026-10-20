import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blueprintId, checkBlueprintMessage, parseBlueprint } from './index.js';

// Every blueprint in spec/blueprints must be a valid Lake Blueprint 0.1: agents build apps from them.
const dir = new URL('../../../spec/blueprints/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');

describe('spec/blueprints', () => {
  it.each(files)('%s is a valid blueprint', (f) => {
    const { meta, problems } = parseBlueprint(readFileSync(new URL(f, dir), 'utf8'));
    expect(problems).toEqual([]);
    expect(meta.messages[`${meta.name}.reject`]).toBeDefined();
  });

  it('checks messages against the blueprint: bp, kind, fields', () => {
    const { meta } = parseBlueprint(readFileSync(new URL('connect4.md', dir), 'utf8'));
    expect(blueprintId(meta)).toBe('c4/1');
    expect(checkBlueprintMessage(meta, { kind: 'c4.move', bp: 'c4/1', match: 'a+b', seq: 1, col: 3 })).toEqual([]);
    expect(checkBlueprintMessage(meta, { kind: 'c4.move', bp: 'c4/2', match: 'a+b', seq: '1', col: 3 })).toEqual(['bp: expected "c4/1", got "c4/2"', 'seq: expected integer']);
    expect(checkBlueprintMessage(meta, { kind: 'c4.cheat', bp: 'c4/1' })).toEqual(['kind: "c4.cheat" is not in this blueprint']);
  });

  it('says what is wrong with a bad one', () => {
    const { problems } = parseBlueprint('---\nblueprint: "0.1"\nname: Chat Room\nversion: 1\ntag: chat\nparticipants: { min: 0 }\nmessages:\n  msg: { fields: { kind: string } }\n---\n# no sections\n');
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/^name:/), expect.stringMatching(/^version:/), expect.stringMatching(/^tag:/), expect.stringMatching(/^participants.min:/),
      expect.stringMatching(/^body: needs a "## Protocol"/), expect.stringMatching(/^body: needs a "## Validation"/),
    ]));
  });
});
