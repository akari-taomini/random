import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planText, renderPlan, exportPreset, parsePreset, validateVariants, parseReply, endpoint, generate, listModels, request } from '../core.js';

const original = 'Keep the original meaning of every sentence.';
const variants = ['Preserve the meaning of each original sentence.', 'Every sentence must retain its original meaning.'];

test('plain lines preserve CRLF, indentation, bullet prefix and final whitespace', () => {
    const input = '# Fixed title\r\n\r\n  - ' + original + '  \r\n';
    const parts = planText(input);
    assert.equal(renderPlan(parts), input);
    const part = parts.find(p => p.id);
    assert.equal(part.original, original);
    part.variants = variants; part.approved = true;
    assert.equal(renderPlan(parts), '# Fixed title\r\n\r\n  - {{random::' + [original, ...variants].join('::') + '}}  \r\n');
});

test('nested multiline macros, fences, tags, links and comments are protected', () => {
    const input = [
        '{{random::first {{user}}::second', 'line}}',
        '```json', original, '```',
        '~~~', original, '~~~',
        '<settings>', '<!-- comment', original, '-->',
        'Text containing {{char}} stays unchanged.',
        'Read [documentation](https://example.com).', original,
    ].join('\n');
    const parts = planText(input);
    assert.equal(parts.filter(p => p.id).length, 1);
    assert.equal(parts.find(p => p.id).original, original);
    assert.equal(renderPlan(parts), input);
});

test('unclosed macro and code fence protect all trailing lines', () => {
    for (const input of ['{{random::test\n' + original, '```\n' + original, '<!--\n' + original]) {
        const parts = planText(input);
        assert.equal(parts.filter(p => p.id).length, 0);
        assert.equal(renderPlan(parts), input);
    }
});

test('macro separator and braces in source cannot enter random options', () => {
    for (const input of ['A meaningful sentence :: another sentence.', 'A meaningful sentence with {something}.']) {
        assert.equal(planText(input).filter(p => p.id).length, 0);
    }
});

test('short labels, config rows and headings are skipped', () => {
    assert.equal(planText('# Heading\nDomain: Character Development\n---\nShort\n| A | B |').filter(p => p.id).length, 0);
});

test('invalid variants are rejected', () => {
    for (const candidate of [[], [original, variants[0]], [variants[0], variants[0]], ['text::another', variants[0]], ['{{user}}', variants[0]], ['line\nbreak', variants[0]], ['<tag>', variants[0]], [17, variants[0]], ['  ', variants[0]]]) {
        assert.throws(() => validateVariants(original, candidate, 2));
    }
    assert.deepEqual(validateVariants(original, variants, 2), variants);
});

test('unapproved variants are never exported', () => {
    const parts = planText(original); parts[0].variants = variants;
    assert.equal(renderPlan(parts), original);
    parts[0].approved = true;
    assert.equal(renderPlan(parts, false), '{{random::' + variants.join('::') + '}}');
    parts[0].variants = [variants[0]];
    assert.throws(() => renderPlan(parts, false));
});

test('export changes only approved content and does not add content to markers', () => {
    const preset = { temperature: 1.2, prompts: [{ identifier: 'marker', marker: true }, { identifier: 'main', content: original, role: 'system' }], prompt_order: [{ order: [{ identifier: 'main', enabled: false }] }], extensions: { nested: [1, 2] } };
    const before = structuredClone(preset);
    const plans = new Map(preset.prompts.map((p, i) => [i, planText(p.content)]));
    assert.deepEqual(exportPreset(preset, plans), preset);
    plans.get(1)[0].variants = variants; plans.get(1)[0].approved = true;
    const result = exportPreset(preset, plans);
    assert.equal(result.prompts[1].content, '{{random::' + [original, ...variants].join('::') + '}}');
    result.prompts[1].content = original;
    assert.deepEqual(result, before);
    assert.deepEqual(preset, before);
});

test('JSON reply contract checks count, ids, duplicates and status', () => {
    const units = [{ id: 'a', text: original }];
    const valid = { units: [{ id: 'a', status: 'ok', variants }] };
    assert.deepEqual(parseReply('```json\n' + JSON.stringify(valid) + '\n```', units, 2), [{ id: 'a', variants }]);
    assert.throws(() => parseReply('not json', units, 2));
    assert.throws(() => parseReply(JSON.stringify({ units: [{ id: 'other', status: 'ok', variants }] }), units, 2));
    assert.throws(() => parseReply(JSON.stringify({ units: [{ id: 'a', status: 'needs_review', reason: 'Meaning is ambiguous.' }] }), units, 2), /ambiguous/);
    assert.throws(() => parseReply(JSON.stringify({ units: [valid.units[0], valid.units[0]] }), units, 2));
});

test('preset parser rejects other JSON types', () => {
    for (const x of [null, [], {}, { prompts: [null] }, { prompts: ['wrong'] }]) assert.throws(() => parsePreset(x));
});

test('endpoint normalizes compatible and native URLs', () => {
    assert.equal(endpoint({ url: 'https://example.com/v1/', provider: 'openai' }), 'https://example.com/v1/chat/completions');
    assert.equal(endpoint({ url: 'https://example.com/v1/chat/completions', provider: 'openai' }, true), 'https://example.com/v1/models');
    assert.equal(endpoint({ url: 'https://example.com/v1beta', provider: 'gemini', model: 'models/test-model' }), 'https://example.com/v1beta/models/test-model:generateContent');
    for (const url of ['javascript:alert(1)', 'https://example.com?key=secret', 'https://u:p@example.com', 'invalid']) assert.throws(() => endpoint({ url, provider: 'openai' }));
});

test('OpenAI adapter sends only own instructions and selected units', async () => {
    let call;
    const result = await generate({ provider: 'openai', url: 'https://example.com/v1', model: 'test', key: 'sample-key' }, [{ id: 'a', text: original }], 2, undefined, async (url, options) => {
        call = { url, options, body: JSON.parse(options.body) };
        return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ units: [{ id: 'a', status: 'ok', variants }] }) } }] }) };
    });
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.headers.Authorization, 'Bearer sample-key');
    assert.equal(call.body.messages.length, 2);
    assert.deepEqual(JSON.parse(call.body.messages[1].content).units, [{ id: 'a', text: original }]);
    assert.equal(result[0].variants.length, 2);
});

test('Gemini adapter ignores thought parts and sends key in header', async () => {
    await generate({ provider: 'gemini', url: 'https://example.com/v1beta', model: 'test', key: 'sample-key' }, [{ id: 'a', text: original }], 2, undefined, async (url, options) => {
        assert.ok(!url.includes('sample-key'));
        assert.equal(options.headers['x-goog-api-key'], 'sample-key');
        assert.ok(JSON.parse(options.body).systemInstruction);
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ thought: true, text: 'internal text' }, { text: JSON.stringify({ units: [{ id: 'a', status: 'ok', variants }] }) }] } }] }) };
    });
});

test('model list filters native non-text models', async () => {
    const models = await listModels({ provider: 'gemini', url: 'https://example.com/v1beta' }, undefined, async () => ({ ok: true, json: async () => ({ models: [{ name: 'models/text', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embed', supportedGenerationMethods: ['embedContent'] }] }) }));
    assert.deepEqual(models, ['text']);
});

test('HTTP failures are sanitized, auth is fatal, rate limits retryable', async () => {
    for (const status of [401, 429, 503]) {
        await assert.rejects(request({ provider: 'openai', url: 'https://example.com/v1' }, {}, { fetchImpl: async () => ({ ok: false, status }) }), e => e.message.includes(String(status)) && (status === 401 ? e.fatal : e.retryable));
    }
});

test('stop aborts in-flight request and no raw provider error is exposed', async () => {
    const controller = new AbortController();
    const pending = request({ provider: 'openai', url: 'https://example.com/v1' }, {}, {
        signal: controller.signal,
        fetchImpl: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason))),
    });
    controller.abort(new DOMException('stopped', 'AbortError'));
    await assert.rejects(pending, /stopped/);
    await assert.rejects(request({ provider: 'openai', url: 'https://example.com/v1' }, {}, { fetchImpl: async () => { throw new TypeError('sensitive details'); } }), /CORS/);
});

test('attached real preset roundtrip preserves all 265 entries and nested macros', () => {
    const path = process.env.PRESET_FIXTURE;
    if (!path) return;
    const preset = JSON.parse(readFileSync(path, 'utf8'));
    const plans = new Map(preset.prompts.map((p, i) => [i, planText(p.content, `p${i}`)]));
    assert.equal(preset.prompts.length, 265);
    assert.deepEqual(exportPreset(preset, plans), preset);
    for (const [i, parts] of plans) assert.equal(renderPlan(parts), preset.prompts[i].content ?? '');
    const first = [...plans.values()].flat().find(p => p.id);
    first.variants = ['A distinctly worded test sentence, for structural validation only.']; first.approved = true;
    const out = exportPreset(preset, plans);
    assert.deepEqual(out.prompt_order, preset.prompt_order);
    assert.equal(out.prompts.filter((p, i) => JSON.stringify(p) !== JSON.stringify(preset.prompts[i])).length, 1);
});
