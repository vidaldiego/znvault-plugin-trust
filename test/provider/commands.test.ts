import { describe, it, expect } from 'vitest';
import { loadManifest, serviceMismatch } from '../../src/cli/provider/commands.js';

const read = (content: string) => async () => Buffer.from(content, 'utf-8');
const VALID = { service: 'vault', trustContractVersion: 'v1', evidenceTypes: [] };

describe('loadManifest', () => {
  it('accepts a manifest carrying the fields the contract needs', async () => {
    await expect(loadManifest('m.json', read(JSON.stringify(VALID)))).resolves.toMatchObject({ service: 'vault' });
  });

  it('names the file when it cannot be read', async () => {
    const boom = async () => { throw new Error('ENOENT'); };
    await expect(loadManifest('/nope.json', boom)).rejects.toThrow(/Could not read the manifest '\/nope.json'/);
  });

  it('says it is the JSON that is broken, not the command', async () => {
    await expect(loadManifest('m.json', read('{oops'))).rejects.toThrow(/is not valid JSON/);
  });

  it('rejects an array, which is what a copy-pasted evidenceTypes block looks like', async () => {
    await expect(loadManifest('m.json', read('[]'))).rejects.toThrow(/must be a JSON object, not an array/);
  });

  // The silent failure this guard exists for: a manifest that parses but is the
  // wrong shape registers fine and only surfaces later as unmapped evidence.
  it.each(['service', 'trustContractVersion', 'evidenceTypes'])('refuses a manifest with no %s', async (field) => {
    const partial: Record<string, unknown> = { ...VALID };
    delete partial[field];
    await expect(loadManifest('m.json', read(JSON.stringify(partial)))).rejects.toThrow(
      new RegExp(`has no '${field}'`),
    );
  });

  it('points at the provider source rather than inviting a hand-written manifest', async () => {
    await expect(loadManifest('m.json', read('{}'))).rejects.toThrow(/byte for byte what the provider signs/);
  });
});

describe('serviceMismatch', () => {
  it('is silent when the manifest agrees with the flag', () => {
    expect(serviceMismatch('vault', VALID)).toBeNull();
  });

  // A mismatch does not fail loudly by itself: `service` decides the HMAC secret
  // alias, so the sync job dies looking for a secret that is not there BEFORE it
  // can write a SyncLog, and the portal shows nothing at all.
  it('reports both names when they disagree', () => {
    expect(serviceMismatch('valut', VALID)).toMatch(/declares service 'vault' but --service says 'valut'/);
  });

  it('stays silent when the manifest declares no service, leaving that to loadManifest', () => {
    expect(serviceMismatch('vault', { trustContractVersion: 'v1' })).toBeNull();
  });
});
