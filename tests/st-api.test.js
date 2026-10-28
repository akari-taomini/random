import test from 'node:test';
import assert from 'node:assert/strict';
import { getProfiles, requireProfile, generateWithProfile } from '../st-api.js';

const unit = { id: 'one', text: 'Keep the meaning of every original sentence.' };
const variants = ['Preserve the meaning in each original sentence.', 'Every original sentence must retain its meaning.'];
const reply = JSON.stringify({ units: [{ id: unit.id, status: 'ok', variants }] });
function mock(send = async () => ({ content: reply, reasoning: 'ignore' })) {
    const profile = { id: 'selected-api', name: 'Saved API', api: 'custom', model: 'saved-model', 'secret-id': 'private-reference', 'api-url': 'https://private-url.test' };
    const context = {
        chat: ['private chat content'],
        extensionSettings: { disabledExtensions: [], connectionManager: { selectedProfile: 'other-api', profiles: [profile] } },
        ConnectionManagerRequestService: { getSupportedProfiles() { return [profile]; }, sendRequest: send },
    };
    return context;
}

test('profile list exposes display metadata only', () => {
    assert.deepEqual(getProfiles(mock()), [{ id: 'selected-api', name: 'Saved API', model: 'saved-model', api: 'custom' }]);
    assert.ok(!JSON.stringify(getProfiles(mock())).includes('private'));
});

test('missing service or disabled connection manager reports actionable errors', () => {
    assert.throws(() => getProfiles({}), /更新酒馆/);
    const context = mock(); context.extensionSettings.disabledExtensions = ['connection-manager'];
    assert.throws(() => getProfiles(context), /未启用/);
});

test('missing and deleted selections fail instead of using a different profile', () => {
    assert.throws(() => requireProfile(mock(), ''), /先选择/);
    assert.throws(() => requireProfile(mock(), 'deleted'), /已被删除/);
});

test('selected profile receives only rewrite messages and uses native secret resolution', async () => {
    let args;
    const context = mock(async (...input) => { args = input; return { content: reply, reasoning: 'not part of JSON' }; });
    const before = structuredClone(context.extensionSettings);
    const result = await generateWithProfile({ profileId: 'selected-api', prompt: 'Rewrite faithfully.' }, [unit], 2, undefined, context);
    assert.deepEqual(result, [{ id: 'one', variants }]);
    assert.equal(args[0], 'selected-api');
    assert.deepEqual(args[1], [{ role: 'system', content: 'Rewrite faithfully.' }, { role: 'user', content: JSON.stringify({ variant_count: 2, units: [unit] }) }]);
    assert.equal(args[2], 16384);
    assert.equal(args[3].includePreset, true);
    assert.equal(args[3].includeInstruct, true);
    assert.equal(args[3].stream, false);
    assert.equal(args[3].extractData, true);
    assert.ok(args[3].signal instanceof AbortSignal);
    assert.deepEqual(context.extensionSettings, before);
    assert.equal(args.length, 4);
});

test('connection result shares the same JSON and macro validation', async () => {
    await assert.rejects(generateWithProfile({ profileId: 'selected-api' }, [unit], 2, undefined, mock(async () => ({ content: 'invalid' }))), /合法 JSON/);
    await assert.rejects(generateWithProfile({ profileId: 'selected-api' }, [unit], 2, undefined, mock(async () => ({ content: '' }))), /没有返回文本/);
    await assert.rejects(generateWithProfile({ profileId: 'selected-api' }, [unit], 2, undefined, mock(async () => ({ content: JSON.stringify({ units: [{ id: 'one', status: 'ok', variants: ['{{random::bad}}', variants[1]] }] }) }))), /结构符号/);
});

test('provider errors are sanitized and status failures are classified', async () => {
    for (const status of [401, 429, 503, 400]) {
        const context = mock(async () => { throw new Error('API request failed', { cause: new Error(`${status} sensitive secret-string`) }); });
        await assert.rejects(generateWithProfile({ profileId: 'selected-api' }, [unit], 2, undefined, context), error => {
            assert.ok(!error.message.includes('secret-string'));
            assert.equal(Boolean(error.retryable), status === 429 || status === 503);
            assert.equal(Boolean(error.fatal), status === 401 || status === 400);
            return true;
        });
    }
});

test('stop aborts only the workshop request, without global stop or profile switch', async () => {
    let signal;
    const controller = new AbortController();
    const context = mock(async (_id, _messages, _tokens, options) => {
        signal = options.signal;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('wrapped', { cause: signal.reason }))));
    });
    context.stopGeneration = () => { throw new Error('Global stop must not be called'); };
    const promise = generateWithProfile({ profileId: 'selected-api' }, [unit], 2, controller.signal, context);
    controller.abort(new DOMException('test stop', 'AbortError'));
    await assert.rejects(promise, /test stop/);
    assert.equal(signal.aborted, true);
    assert.equal(context.extensionSettings.connectionManager.selectedProfile, 'other-api');
});

test('an already aborted signal never sends a request', async () => {
    let calls = 0;
    const context = mock(async () => { calls++; return { content: reply }; });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(generateWithProfile({ profileId: 'selected-api' }, [unit], 2, controller.signal, context));
    assert.equal(calls, 0);
});
