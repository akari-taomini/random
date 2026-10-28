import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBatches, RequestPacer } from '../batch.js';
import { parseBatchReply, generate, request } from '../core.js';
import { generateWithProfile } from '../st-api.js';

const job = (id, length = 30) => ({ index: 0, part: { id, original: 'a'.repeat(length) } });
const units = [{ id: 'a', text: 'Keep the original meaning.' }, { id: 'b', text: 'Maintain the original tone.' }];
const good = { id: 'a', status: 'ok', variants: ['Preserve the initial meaning.', 'Retain the meaning of the source.'] };
const goodB = { id: 'b', status: 'ok', variants: ['Retain the source tone.', 'Preserve the initial tone.'] };

test('batch size combines units across entries without changing order or losing jobs', () => {
    const jobs = Array.from({ length: 12 }, (_, i) => ({ ...job(String(i)), index: i % 3 }));
    const batches = makeBatches(jobs, 5, 3);
    assert.deepEqual(batches.map(b => b.length), [5, 5, 2]);
    assert.deepEqual(batches.flat(), jobs);
    assert.equal(makeBatches(jobs, 1, 3).length, 12);
    assert.deepEqual(makeBatches([], 5, 3), []);
    for (const size of [0, 51, 2.5]) assert.throws(() => makeBatches(jobs, size));
});

test('character estimate reduces batches as text/variant count grows', () => {
    const jobs = [job('1', 500), job('2', 500), job('3', 500)];
    assert.equal(makeBatches(jobs, 5, 1, 5000).length, 1);
    assert.equal(makeBatches(jobs, 5, 8, 5000).length, 3);
    const large = [job('oversize', 6000), job('small', 20)];
    assert.deepEqual(makeBatches(large, 5, 8).map(b => b.length), [1, 1]);
});

test('batch replies map reordered ids and preserve valid siblings of failed/missing units', () => {
    const result = parseBatchReply(JSON.stringify({ units: [{ id: 'b', status: 'needs_review', reason: 'ambiguous' }, good] }), units, 2);
    assert.deepEqual(result[0], { id: 'a', variants: good.variants });
    assert.equal(result[1].error, 'ambiguous');
    const missing = parseBatchReply(JSON.stringify({ units: [good] }), units, 2);
    assert.ok(missing[0].variants); assert.match(missing[1].error, /未返回/);
    const duplicate = parseBatchReply(JSON.stringify({ units: [good, good, goodB] }), units, 2);
    assert.match(duplicate[0].error, /重复/); assert.ok(duplicate[1].variants);
    assert.throws(() => parseBatchReply(JSON.stringify({ units: [good, { ...goodB, id: 'unknown' }] }), units, 2), /未请求/);
    assert.throws(() => parseBatchReply('truncated', units, 2), /合法 JSON/);
});

test('bad variants fail per unit, without allowing macros or duplicates through', () => {
    const result = parseBatchReply(JSON.stringify({ units: [{ ...good, variants: ['{{bad}}', 'text'] }, goodB] }), units, 2);
    assert.match(result[0].error, /结构符号/);
    assert.deepEqual(result[1].variants, goodB.variants);
});

test('RPM pacing counts every start, survives runs and can be disabled', async () => {
    let clock = 0;
    const pacer = new RequestPacer({ now: () => clock, wait: async ms => { clock += ms; } });
    const starts = [];
    for (let i = 0; i < 11; i++) { await pacer.beforeRequest(10); starts.push(clock); }
    assert.equal(starts[0], 0);
    assert.ok(starts[1] >= 6000);
    assert.ok(starts[10] > 60000);
    await pacer.beforeRequest(0);
    assert.equal(clock, starts[10]);
    pacer.defer(8000);
    await pacer.beforeRequest(0);
    assert.equal(clock, starts[10] + 8000);
    await assert.rejects(pacer.beforeRequest(-1));
});

test('cancellation while pacing never records a new request start', async () => {
    const controller = new AbortController();
    const pacer = new RequestPacer({ now: () => 0, wait: async () => { controller.abort(new Error('stopped')); throw controller.signal.reason; } });
    await pacer.beforeRequest(10);
    await assert.rejects(pacer.beforeRequest(10, controller.signal), /stopped/);
    assert.equal(pacer.lastStarted, 0);
    const preAborted = new AbortController(); preAborted.abort();
    await assert.rejects(pacer.beforeRequest(0, preAborted.signal));
});

test('direct API batches all input units into one request and returns partial outcomes', async () => {
    let calls = 0;
    const result = await generate({ provider: 'openai', url: 'https://example.test/v1', model: 'test', partialResults: true }, units, 2, undefined, async (_url, options) => {
        calls++;
        assert.equal(JSON.parse(JSON.parse(options.body).messages[1].content).units.length, 2);
        return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ units: [good, { id: 'b', status: 'needs_review', reason: 'ambiguous' }] }) } }] }) };
    });
    assert.equal(calls, 1); assert.ok(result[0].variants); assert.equal(result[1].error, 'ambiguous');
});

test('saved ST profile batches use one service call and preserve valid siblings', async () => {
    let calls = 0;
    const context = { ConnectionManagerRequestService: {
        getSupportedProfiles: () => [{ id: 'p', name: 'test' }],
        sendRequest: async (_id, messages) => {
            calls++; assert.equal(JSON.parse(messages[1].content).units.length, 2);
            return { content: JSON.stringify({ units: [good, { id: 'b', status: 'needs_review', reason: 'ambiguous' }] }) };
        },
    } };
    const result = await generateWithProfile({ profileId: 'p', partialResults: true }, units, 2, undefined, context);
    assert.equal(calls, 1); assert.ok(result[0].variants); assert.equal(result[1].error, 'ambiguous');
});

test('Retry-After is retained for cooldown scheduling', async () => {
    await assert.rejects(request({ provider: 'openai', url: 'https://example.test/v1' }, {}, {
        fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => '30' } }),
    }), error => error.rateLimited && error.retryAfterMs === 30000);
});
