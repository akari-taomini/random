import { parsePreset } from './core.js';

// Export-key -> runtime-key aliases in ST's chat-completion settings. Do not
// copy the entire runtime settings object: it also contains API connections.
const aliases = {
    temperature: 'temp_openai', frequency_penalty: 'freq_pen_openai',
    presence_penalty: 'pres_pen_openai', top_p: 'top_p_openai', top_k: 'top_k_openai',
    top_a: 'top_a_openai', min_p: 'min_p_openai', repetition_penalty: 'repetition_penalty_openai',
};
const ordinaryKeys = `max_context_unlocked tool_reasoning_mode openai_max_context openai_max_tokens names_behavior send_if_empty impersonation_prompt new_chat_prompt new_group_chat_prompt new_example_chat_prompt continue_nudge_prompt bias_preset_selected wi_format scenario_format personality_format group_nudge_prompt stream_openai prompts prompt_order assistant_prefill assistant_impersonation use_sysprompt squash_system_messages media_inlining inline_image_quality continue_prefill continue_postfix function_calling tool_call_recurse_limit show_thoughts reasoning_effort verbosity enable_web_search seed n request_images request_image_aspect_ratio request_image_resolution extensions`.split(' ');
const fallbackFields = Object.fromEntries([
    ...Object.entries(aliases).map(([key, runtime]) => [key, ['', runtime, false, false]]),
    ...ordinaryKeys.map(key => [key, ['', key, false, false]]),
]);

function object(value) {
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function presetObject(value) {
    const parsed = object(value);
    if (!Array.isArray(parsed?.prompts)) return null;
    try { return parsePreset(parsed); } catch { return null; }
}
function savedFromList(list, name) {
    const names = list?.preset_names;
    const index = Array.isArray(names) ? names.indexOf(name) : names?.[name];
    return index !== undefined && index !== -1 ? presetObject(list?.presets?.[index]) : null;
}

export async function readCurrentChatPreset({
    context = globalThis.SillyTavern?.getContext?.(),
    document = globalThis.document,
    loadOpenAI = () => import(new URL('../../../openai.js', import.meta.url).href),
} = {}) {
    let manager, list, openai;
    try { manager = context?.getPresetManager?.('openai'); } catch { /* old/forked context */ }
    try { list = manager?.getPresetList?.(); } catch { /* live context can still work */ }
    const contextual = object(context?.chatCompletionSettings), listed = object(list?.settings);
    let live = Array.isArray(contextual?.prompts) ? contextual : Array.isArray(listed?.prompts) ? listed : contextual || listed;
    const selectedName = () => {
        // This is the chat-completion preset dropdown, not the API connection
        // profile selector or the prompt-group dropdown shown by other plugins.
        const option = document?.querySelector?.('#settings_preset_openai')?.selectedOptions?.[0];
        if (option?.textContent?.trim()) return option.textContent.trim();
        if (live?.preset_settings_openai) return String(live.preset_settings_openai);
        try { return manager?.getSelectedPresetName?.() || ''; } catch { return ''; }
    };
    let name = selectedName(), saved;
    try { saved = presetObject(manager?.getCompletionPresetByName?.(name)); } catch { /* list fallback */ }
    saved ||= savedFromList(list, name);

    // Older contexts may not expose the manager or current chat settings. The
    // module is already loaded by ST; import reuses its live ESM bindings.
    if (!saved || !Array.isArray(live?.prompts)) {
        try { openai = await loadOpenAI(); } catch { /* supported context paths need no module import */ }
        if (!Array.isArray(live?.prompts)) live = object(openai?.oai_settings) || live;
        const latestName = selectedName() || String(openai?.oai_settings?.preset_settings_openai || '');
        if (latestName !== name) {
            saved = null;
            try { saved = presetObject(manager?.getCompletionPresetByName?.(latestName)); } catch { /* module fallback */ }
        }
        name = latestName;
        saved ||= savedFromList({ presets: openai?.openai_settings, preset_names: openai?.openai_setting_names }, name);
    }

    if (Array.isArray(live?.prompts)) {
        const snapshot = saved ? structuredClone(saved) : {};
        const fields = { ...fallbackFields, ...object(openai?.settingsToUpdate) };
        for (const [key, descriptor] of Object.entries(fields)) {
            if (!Array.isArray(descriptor) || descriptor[3]) continue;
            const runtimeKey = descriptor[1];
            if (typeof runtimeKey === 'string' && Object.hasOwn(live, runtimeKey) && live[runtimeKey] !== undefined) {
                snapshot[key] = structuredClone(live[runtimeKey]);
            }
        }
        // Forks can expose canonical export keys instead of ST's runtime aliases.
        for (const key of Object.keys(aliases)) {
            if (!Object.hasOwn(live, aliases[key]) && Object.hasOwn(live, key) && live[key] !== undefined) snapshot[key] = structuredClone(live[key]);
        }
        return { preset: parsePreset(snapshot), name: name || '当前对话补全预设', source: 'live' };
    }
    if (saved) return { preset: saved, name: name || '当前对话补全预设', source: 'saved' };
    throw new Error('无法读取当前对话补全预设，请确认已选择预设并等待酒馆加载完成；也可先导出 JSON 后上传。');
}
