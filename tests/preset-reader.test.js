import test from 'node:test';
import assert from 'node:assert/strict';
import { readCurrentChatPreset } from '../preset-reader.js';
import { readFileSync } from 'node:fs';

const source = { temperature: 1.2, prompts: [{ identifier: 'main', content: 'Saved instructions.' }, { identifier: 'chatHistory', marker: true }], prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }], extensions: { grouping: { name: 'Saved group' } }, custom_metadata: { keep: true } };
const live = () => ({ preset_settings_openai: 'Selected preset', temp_openai: 0, prompts: [{ identifier: 'main', content: 'Unsaved instructions from the current screen.' }, { identifier: 'chatHistory', marker: true }], prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: false }] }], extensions: { grouping: { name: 'Unsaved group' } }, custom_url: 'https://private.test', proxy_password: 'do-not-copy' });
const manager = () => ({ getSelectedPresetName: () => 'Selected preset', getPresetSettings: () => { throw new Error('Generic getter must not be used for chat completion'); }, getCompletionPresetByName: () => source });
const noModule = async () => { throw new Error('Module import should not be needed'); };

test('reads live chat-completion data instead of the generic getter, preserving saved metadata', async () => {
    const state = live(), saved = structuredClone(source);
    const result = await readCurrentChatPreset({ context: { chatCompletionSettings: state, getPresetManager: manager }, loadOpenAI: noModule });
    assert.equal(result.name, 'Selected preset'); assert.equal(result.source, 'live');
    assert.equal(result.preset.prompts[0].content, state.prompts[0].content);
    assert.deepEqual(result.preset.prompt_order, state.prompt_order);
    assert.deepEqual(result.preset.extensions, state.extensions);
    assert.deepEqual(result.preset.custom_metadata, source.custom_metadata);
    assert.equal(result.preset.temperature, 0);
    assert.ok(!Object.hasOwn(result.preset, 'temp_openai'));
    assert.ok(!Object.hasOwn(result.preset, 'custom_url'));
    assert.ok(!Object.hasOwn(result.preset, 'proxy_password'));
    result.preset.prompts[0].content = 'Edited copy';
    assert.equal(state.prompts[0].content, 'Unsaved instructions from the current screen.');
    assert.deepEqual(source, saved);
});

test('official getPresetList settings and serialized saved presets work without chatCompletionSettings', async () => {
    const state = live();
    const result = await readCurrentChatPreset({ context: { getPresetManager: () => ({ getSelectedPresetName: () => 'Selected preset', getPresetSettings: () => ({}), getPresetList: () => ({ settings: state, presets: [JSON.stringify(source)], preset_names: { 'Selected preset': 0 } }) }) }, loadOpenAI: noModule });
    assert.equal(result.source, 'live');
    assert.equal(result.preset.prompts[0].content, state.prompts[0].content);
});

test('legacy context falls back to official openai module live bindings', async () => {
    let imported = 0;
    const result = await readCurrentChatPreset({ context: {}, loadOpenAI: async () => {
        imported++;
        return { oai_settings: live(), openai_settings: [JSON.stringify(source)], openai_setting_names: { 'Selected preset': 0 }, settingsToUpdate: { temperature: ['', 'temp_openai', false, false], proxy_password: ['', 'proxy_password', false, true] } };
    } });
    assert.equal(imported, 1); assert.equal(result.source, 'live');
    assert.equal(result.preset.temperature, 0);
    assert.equal(result.preset.prompts[0].content, 'Unsaved instructions from the current screen.');
    assert.ok(!JSON.stringify(result.preset).includes('do-not-copy'));
});

test('saved-only fallback is labelled and returns a detached copy', async () => {
    const result = await readCurrentChatPreset({ context: { getPresetManager: manager }, loadOpenAI: noModule });
    assert.equal(result.source, 'saved'); assert.deepEqual(result.preset, source);
    result.preset.extensions.grouping.name = 'Copy';
    assert.equal(source.extensions.grouping.name, 'Saved group');
});

test('actual chat preset dropdown takes precedence over unrelated group/profile selections', async () => {
    let requestedName;
    const result = await readCurrentChatPreset({ context: { chatCompletionSettings: live(), getPresetManager: () => ({ ...manager(), getCompletionPresetByName: name => { requestedName = name; return source; } }) }, document: { querySelector: selector => selector === '#settings_preset_openai' ? { selectedOptions: [{ textContent: '  Screen selected preset  ' }] } : null }, loadOpenAI: noModule });
    assert.equal(requestedName, 'Screen selected preset'); assert.equal(result.name, 'Screen selected preset');
});

test('live-only canonical fork settings can be read without importing internal modules', async () => {
    const state = { prompts: source.prompts, prompt_order: source.prompt_order, temperature: 0.7, extensions: source.extensions, api_key: 'never copy' };
    const result = await readCurrentChatPreset({ context: { chatCompletionSettings: state }, loadOpenAI: noModule });
    assert.equal(result.preset.temperature, 0.7);
    assert.ok(!JSON.stringify(result.preset).includes('never copy'));
});

test('array preset-name maps work and initialization failures report a useful error', async () => {
    const result = await readCurrentChatPreset({ context: { getPresetManager: () => ({ getSelectedPresetName: () => 'Selected preset', getPresetList: () => ({ presets: [source], preset_names: ['Selected preset'] }) }) }, loadOpenAI: noModule });
    assert.equal(result.source, 'saved');
    await assert.rejects(readCurrentChatPreset({ context: {}, loadOpenAI: noModule }), /无法读取当前对话补全预设/);
});

test('real attached preset keeps all 265 entries, groups and order when reading current state', async () => {
    if (!process.env.PRESET_FIXTURE) return;
    const preset = JSON.parse(readFileSync(process.env.PRESET_FIXTURE, 'utf8'));
    const state = { ...preset, preset_settings_openai: '万象合鸣', temp_openai: preset.temperature };
    const result = await readCurrentChatPreset({ context: { chatCompletionSettings: state, getPresetManager: () => ({ getCompletionPresetByName: () => preset }) }, loadOpenAI: noModule });
    assert.equal(result.preset.prompts.length, 265);
    assert.deepEqual(result.preset, preset);
});
