# Pi Codex usage evidence

`pi-codex-usage.json` records **synthetic, offline outputs from the publisher's actual normalizer**, not inferred units or live account data. The fixture's provenance pins `@earendil-works/pi-ai` 0.87.1, its npm tarball/integrity, and source commit `f07218c4d4bbc12bef056a7058c3dd49dfe41abe`.

Authoritative paths at that commit:

- [`packages/ai/src/api/openai-codex-responses.ts`](https://github.com/earendil-works/pi/blob/f07218c4d4bbc12bef056a7058c3dd49dfe41abe/packages/ai/src/api/openai-codex-responses.ts): both HTTP/SSE and WebSocket response processing call `processResponsesStream`.
- [`packages/ai/src/api/openai-responses-shared.ts`](https://github.com/earendil-works/pi/blob/f07218c4d4bbc12bef056a7058c3dd49dfe41abe/packages/ai/src/api/openai-responses-shared.ts): terminal-response normalization explicitly subtracts both `input_tokens_details.cached_tokens` and `cache_write_tokens` from OpenAI's inclusive `input_tokens` when producing Pi `usage.input`. Reads and writes are stored separately. Reasoning remains a subset of output.

The installed modules used for the probe matched the published tarball bytes (whose SHA-512 matched npm metadata). Their SHA-256 digests were:

- `dist/api/openai-codex-responses.js`: `6e69310d77278231cfc87d7f03ee815d4a0f2ff273e6c43fcee6835e7df2b0c7`
- `dist/api/openai-responses-shared.js`: `7846279b34c2a569bda2b0753c8b083f8b976204b4fdd7586095ebbb6a643410`

This establishes **cache-exclusive input as the adapter contract**, independent of the numeric relationship between input and cached tokens. Cases cover reads below, equal to, and above the normalized input, zero reads, and separate cache writes. Zero `cost` fields result from deliberately zero-valued model prices in the probe: this artifact verifies token normalization only, never billing rates. Production pricing uses the separately sourced quota-axi rate card.

## Reproduce offline

Point `PI_AI_PACKAGE` at an installed, publisher-verified copy of version 0.87.1 (with its ordinary dependencies). From the quota-axi root, this runs only the pure stream processor against the fixture's synthetic completion events; it never launches Pi, opens credentials, or calls a provider. This development-only probe is not a CI dependency. CI consumes the recorded fixture through quota-axi's real history command and asserts native counts, pricing, and forecast behavior.

```sh
PI_AI_PACKAGE=/path/to/node_modules/@earendil-works/pi-ai node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

globalThis.fetch = () => { throw new Error('offline probe: network forbidden'); };
const root = process.env.PI_AI_PACKAGE;
assert.equal(JSON.parse(readFileSync(`${root}/package.json`, 'utf8')).version, '0.87.1');
const { processResponsesStream } = await import(pathToFileURL(`${root}/dist/api/openai-responses-shared.js`).href);
const fixture = JSON.parse(readFileSync('test/fixtures/history/pi-codex-usage.json', 'utf8'));
for (const { openaiUsage, piMessage } of fixture.cases) {
  const message = { role: 'assistant', provider: 'openai-codex', api: 'openai-codex-responses', model: piMessage.model, content: [] };
  async function* events() {
    yield { type: 'response.completed', response: { id: piMessage.responseId, status: 'completed', output: [], usage: openaiUsage } };
  }
  await processResponsesStream(events(), message, { push() {} }, {
    id: message.model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  assert.deepEqual(message, piMessage);
}
console.log('All recorded Pi normalization cases match the publisher adapter.');
JS
```
