import { DEFAULT_PROMPT, parsePreset, planText, generate, listModels, exportPreset, renderPlan, validateVariants, endpoint } from './core.js';

const MODULE = 'taomini_preset_variants';
const defaults = { provider: 'openai', url: '', model: '', count: 3, includeOriginal: true, prompt: DEFAULT_PROMPT };
const ctx = () => globalThis.SillyTavern?.getContext?.();
let preset, presetName = '', plans = new Map(), selected = new Set(), busy = false, controller;
let activeIndex = -1;
const settings = { ...defaults, ...(ctx()?.extensionSettings?.[MODULE] ?? {}) };
const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

const panel = el('section', 'tmv');
panel.innerHTML = `
 <header class="tmv-header"><div><span class="tmv-eyebrow">桃mini · PRESET STUDIO</span><h2>同义随机宏工坊</h2><p>留住句意，让表达多一种可能。</p></div><button type="button" data-a="close" class="tmv-close" aria-label="关闭">×</button></header>
 <div class="tmv-scroll">
 <details class="tmv-card" open><summary>① 改写 API</summary>
  <div class="tmv-grid">
   <label>接口格式<select data-f="provider"><option value="openai">OpenAI 兼容</option><option value="gemini">Gemini 原生</option></select></label>
   <label>新增变体数（不含原文）<input data-f="count" type="number" min="1" max="8" value="3"></label>
   <label class="tmv-wide">API 基础地址<input data-f="url" type="url" placeholder="https://你的接口/v1" autocomplete="off"></label>
   <label class="tmv-wide">API Key<input data-f="key" type="password" placeholder="仅在本次页面内使用，刷新后清空" autocomplete="off"></label>
   <label class="tmv-wide">模型<div class="tmv-row"><input data-f="model" list="tmv-models" placeholder="填写模型 ID"><button type="button" data-a="models">拉取模型</button></div><datalist id="tmv-models"></datalist></label>
  </div>
  <label class="tmv-check"><input data-f="includeOriginal" type="checkbox" checked>把原文也放入随机选项</label>
  <p class="tmv-note">只将选中且适合改写的文本发给此接口。密钥不写入预设或插件设置；接口需支持浏览器跨域请求。</p>
  <details><summary>内置改写提示词 · 可编辑</summary><textarea data-f="prompt" rows="10" spellcheck="false"></textarea><button type="button" data-a="reset-prompt">恢复默认提示词</button></details>
 </details>
 <section class="tmv-card"><h3>② 选择预设条目</h3>
  <div class="tmv-row tmv-wrap"><button type="button" data-a="current">读取当前预设</button><button type="button" data-a="upload">上传预设 JSON</button><input type="file" data-f="file" accept=".json,application/json" hidden></div>
  <p data-v="source" class="tmv-note">还没有读取预设。</p>
  <div class="tmv-row"><input data-f="search" placeholder="搜索条目名称" aria-label="搜索条目名称"><button type="button" data-a="all">选择可见</button><button type="button" data-a="none">清空选择</button></div>
  <div data-v="entries" class="tmv-entries"></div>
  <p data-v="selection" class="tmv-note">已选择 0 项</p>
 </section>
 <section class="tmv-card"><h3>③ 生成与审核</h3>
  <div class="tmv-row tmv-wrap"><button type="button" data-a="generate" class="tmv-primary">生成选中条目</button><button type="button" data-a="retry">重试失败段落</button><button type="button" data-a="stop" disabled>停止</button></div>
  <p data-v="status" class="tmv-status" role="status" aria-live="polite">等待开始。已有宏、代码、标签行会保留原文。</p>
  <progress data-v="progress" max="1" value="0"></progress>
  <div class="tmv-row"><label class="tmv-grow">预览条目<select data-f="preview"></select></label></div>
  <p class="tmv-note">结构校验不能保证句意等价，请阅读变体后勾选“采用此段”。未采用或失败的段落保留原文。</p>
  <div data-v="review"></div>
 </section>
 <section class="tmv-card"><h3>④ 导出新预设</h3>
  <label>新预设文件名<input data-f="filename" placeholder="预设名-同义随机宏"></label>
  <div class="tmv-row tmv-wrap"><button type="button" data-a="export" class="tmv-primary">导出已审核预设</button><button type="button" data-a="draft">保存审核草稿</button><button type="button" data-a="load-draft">恢复草稿</button><input type="file" data-f="draftfile" accept=".json,application/json" hidden></div>
  <p class="tmv-note">导出为新 JSON；到酒馆预设面板导入即可。草稿包含原预设和生成进度，方便下次接着审核。</p>
 </section>
 <footer class="tmv-note">桃mini & GPT · v1.0.0 · 欢迎标注作者后二改与分享，非商业使用。</footer>
 </div>`;

const q = s => panel.querySelector(s);
const f = name => q(`[data-f="${name}"]`);
const v = name => q(`[data-v="${name}"]`);
const a = name => q(`[data-a="${name}"]`);
for (const key of Object.keys(defaults)) {
    if (typeof defaults[key] === 'boolean') f(key).checked = Boolean(settings[key]);
    else f(key).value = settings[key];
}

function config() {
    const count = Number(f('count').value);
    if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error('新增变体数应为 1～8 的整数。');
    if (!f('includeOriginal').checked && count < 2) throw new Error('不包含原文时，至少需要两个新增变体。');
    return { provider: f('provider').value, url: f('url').value.trim(), model: f('model').value.trim(), key: f('key').value.trim(), count, includeOriginal: f('includeOriginal').checked, prompt: f('prompt').value };
}

function saveSettings() {
    const current = ctx();
    if (!current?.extensionSettings) return;
    const conf = config();
    delete conf.key;
    current.extensionSettings[MODULE] = conf;
    current.saveSettingsDebounced?.();
}

function status(message, error = false) {
    v('status').textContent = message;
    v('status').classList.toggle('tmv-error', error);
}

function setBusy(value) {
    busy = value;
    panel.querySelectorAll('button, input, select, textarea').forEach(x => {
        x.disabled = value && x !== a('stop') && x !== a('close');
    });
    a('stop').disabled = !value;
}

function load(value, name) {
    const parsed = parsePreset(value);
    preset = parsed; presetName = name.replace(/\.json$/i, '');
    plans = new Map(); selected = new Set(); activeIndex = -1;
    f('filename').value = `${presetName || '预设'}-同义随机宏`;
    v('source').textContent = `${presetName} · ${preset.prompts.length} 个条目`;
    renderEntries(); renderReview();
    status('预设已读取，请勾选需要改写的条目。');
}

function ensurePlan(i) {
    if (!plans.has(i)) plans.set(i, planText(preset.prompts[i].content ?? '', `p${i}`));
    return plans.get(i);
}

function renderEntries() {
    v('entries').replaceChildren();
    const search = f('search').value.toLowerCase();
    (preset?.prompts ?? []).forEach((entry, i) => {
        if (!String(entry.name ?? entry.identifier ?? i).toLowerCase().includes(search)) return;
        const count = ensurePlan(i).filter(p => p.id).length;
        const row = el('label', 'tmv-entry');
        const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(i); checkbox.disabled = !count;
        checkbox.addEventListener('change', () => { checkbox.checked ? selected.add(i) : selected.delete(i); renderSelection(); });
        const title = el('span', 'tmv-grow', entry.name ?? entry.identifier ?? `条目 ${i + 1}`);
        row.append(checkbox, title, el('span', 'tmv-badge', count ? `${count} 段` : '保留'));
        row.dataset.index = i;
        v('entries').append(row);
    });
    renderSelection();
}

function renderSelection() {
    const count = [...selected].reduce((n, i) => n + ensurePlan(i).filter(p => p.id).length, 0);
    v('selection').textContent = `已选择 ${selected.size} 项 · ${count} 个可改写段落`;
    const previous = f('preview').value;
    f('preview').replaceChildren();
    for (const i of [...new Set([...selected, ...[...plans].filter(([, parts]) => parts.some(p => p.variants?.length || p.error)).map(([i]) => i)])]) {
        const option = el('option', '', preset.prompts[i].name ?? `条目 ${i + 1}`); option.value = i;
        f('preview').append(option);
    }
    if ([...f('preview').options].some(o => o.value === previous)) f('preview').value = previous;
    activeIndex = f('preview').value === '' ? -1 : Number(f('preview').value);
    renderReview();
}

function renderReview() {
    v('review').replaceChildren();
    if (activeIndex < 0 || !preset) return;
    const parts = ensurePlan(activeIndex);
    const skipped = parts.filter(p => !p.id && p.raw.trim());
    if (skipped.length) {
        const details = el('details'); details.append(el('summary', '', `保留原文的结构行：${skipped.length} 行`));
        for (const p of skipped) details.append(el('p', 'tmv-note', `${p.reason}：${p.raw.trim().slice(0, 100)}`));
        v('review').append(details);
    }
    for (const part of parts.filter(p => p.id)) {
        const card = el('div', 'tmv-unit');
        card.append(el('div', 'tmv-eyebrow', '原文'), el('p', 'tmv-original', part.original));
        if (part.error) card.append(el('p', 'tmv-error', part.error));
        const inputs = [];
        part.variants.forEach((variant, j) => {
            const label = el('label', '', `变体 ${j + 1}`), input = el('textarea');
            input.rows = Math.min(7, Math.max(2, Math.ceil(variant.length / 65)));
            input.value = variant; input.spellcheck = false;
            input.addEventListener('input', () => { part.approved = false; approve.checked = false; part.variants[j] = input.value; part.error = ''; });
            inputs.push(input); label.append(input); card.append(label);
        });
        const actions = el('div', 'tmv-row tmv-wrap');
        const label = el('label', 'tmv-check'), approve = el('input'); approve.type = 'checkbox'; approve.checked = part.approved;
        approve.disabled = !part.variants.length;
        approve.addEventListener('change', () => {
            try { validateVariants(part.original, part.variants, part.variants.length); part.approved = approve.checked; }
            catch (error) { approve.checked = false; part.approved = false; status(error.message, true); }
        });
        label.append(approve, document.createTextNode('采用此段'));
        const retry = el('button', '', part.variants.length ? '重生成此段' : '生成此段'); retry.type = 'button';
        retry.addEventListener('click', () => run([{ part, index: activeIndex }]));
        const reset = el('button', '', '保留原文'); reset.type = 'button';
        reset.addEventListener('click', () => { part.approved = false; approve.checked = false; });
        actions.append(label, retry, reset); card.append(actions); v('review').append(card);
    }
    const preview = el('details'), output = el('pre', 'tmv-output');
    preview.append(el('summary', '', '查看此条目导出内容'));
    preview.addEventListener('toggle', () => { if (preview.open) { try { output.textContent = renderPlan(parts, f('includeOriginal').checked); } catch (e) { output.textContent = e.message; } } });
    preview.append(output); v('review').append(preview);
    if (busy) panel.querySelectorAll('[data-v="review"] button,[data-v="review"] input,[data-v="review"] textarea').forEach(x => { x.disabled = true; });
}

function download(name, value) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = el('a'); link.href = url; link.download = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\.json$/i, '') + '.json';
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function readFile(file) {
    if (!file) return null;
    if (file.size > 20 * 1024 * 1024) throw new Error('文件超过 20 MB，请先缩小预设。');
    try { return JSON.parse(await file.text()); } catch { throw new Error('文件不是合法 JSON。'); }
}

const wait = (ms, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
});

async function run(jobs) {
    if (busy) return;
    let conf;
    try { conf = config(); if (!conf.url || !conf.model) throw new Error('先填写 API 地址和模型。'); endpoint(conf); saveSettings(); }
    catch (error) { status(error.message, true); return; }
    if (!jobs.length) { status('没有待处理的段落。'); return; }
    // Config is captured once: changing UI cannot alter a running job.
    controller = new AbortController(); setBusy(true);
    let done = 0, failed = 0, attempts = 0;
    v('progress').max = jobs.length; v('progress').value = 0;
    try {
        for (const { part, index } of jobs) {
            if (controller.signal.aborted) break;
            status(`正在生成 ${done + 1}/${jobs.length} · ${preset.prompts[index].name ?? '条目'} · 每段最多请求两次`);
            part.approved = false;
            let result;
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    attempts++;
                    result = await generate(conf, [{ id: part.id, text: part.original }], conf.count, controller.signal);
                    break;
                } catch (error) {
                    if (controller.signal.aborted) throw error;
                    if (attempt === 0 && error.retryable) { await wait(1800, controller.signal); continue; }
                    part.error = error.message; failed++;
                    if (error.fatal) throw error;
                    break;
                }
            }
            if (result) { part.variants = result[0].variants; part.error = ''; }
            done++; v('progress').value = done;
            if (index === activeIndex) renderReview();
        }
        status(`${controller.signal.aborted ? '已停止' : '生成完成'}：处理 ${done}/${jobs.length} 段，失败 ${failed} 段，共请求 ${attempts} 次。请审核后采用。`);
    } catch (error) { status(controller.signal.aborted ? `已停止，保留已完成的结果（${done} 段）。` : error.message, !controller.signal.aborted); }
    finally { setBusy(false); renderEntries(); }
}

const handlers = {
    close() { panel.closest('dialog')?.close(); },
    current() {
        const manager = ctx()?.getPresetManager?.('openai');
        if (!manager?.getPresetSettings) throw new Error('此版本无法读取当前预设，请使用“上传预设 JSON”。');
        const name = manager.getSelectedPresetName();
        load(manager.getPresetSettings(name), name || '当前预设');
    },
    upload() { f('file').click(); },
    all() { v('entries').querySelectorAll('[data-index]').forEach(row => { if (!row.querySelector('input').disabled) selected.add(Number(row.dataset.index)); }); renderEntries(); },
    none() { selected.clear(); renderEntries(); },
    async models() {
        if (busy) return;
        const conf = config(); saveSettings(); controller = new AbortController(); setBusy(true); status('正在拉取模型列表…');
        try {
            const models = await listModels(conf, controller.signal);
            const list = q('#tmv-models'); list.replaceChildren();
            models.forEach(name => { const o = el('option'); o.value = name; list.append(o); });
            if (!conf.model && models.length) f('model').value = models[0];
            status(`已拉取 ${models.length} 个模型，可在模型输入框中选择或手填。`);
        } finally { setBusy(false); }
    },
    'reset-prompt'() { f('prompt').value = DEFAULT_PROMPT; saveSettings(); },
    generate() {
        if (!preset || !selected.size) throw new Error('先读取预设并选择条目。');
        const jobs = [...selected].flatMap(index => ensurePlan(index).filter(part => part.id && !part.variants.length).map(part => ({ part, index })));
        return run(jobs);
    },
    retry() {
        const jobs = [...plans].filter(([i]) => selected.has(i)).flatMap(([index, parts]) => parts.filter(part => part.id && part.error).map(part => ({ part, index })));
        return run(jobs);
    },
    stop() { controller?.abort(new DOMException('用户停止', 'AbortError')); status('正在停止…'); },
    export() {
        if (!preset) throw new Error('请先读取预设。');
        config();
        const approved = [...plans.values()].flat().filter(p => p.approved).length;
        if (!approved) throw new Error('还没有采用的段落，请先审核并勾选“采用此段”。');
        download(f('filename').value.trim() || `${presetName}-同义随机宏`, exportPreset(preset, plans, f('includeOriginal').checked));
        status(`已导出 ${approved} 个审核段落；原预设的其他内容与条目顺序已保留。`);
    },
    draft() {
        if (!preset) throw new Error('请先读取预设。');
        download(`${presetName}-审核草稿`, { type: MODULE, version: 1, preset, presetName, plans: [...plans], selected: [...selected], includeOriginal: f('includeOriginal').checked });
        status('草稿已导出；不包含 API Key。');
    },
    'load-draft'() { f('draftfile').click(); },
};

panel.addEventListener('click', async event => {
    const button = event.target.closest('button[data-a]');
    if (!button) return;
    try { await handlers[button.dataset.a]?.(); } catch (error) { status(error.message ?? '操作失败。', true); }
});
f('search').addEventListener('input', renderEntries);
f('preview').addEventListener('change', () => { activeIndex = f('preview').value === '' ? -1 : Number(f('preview').value); renderReview(); });
f('provider').addEventListener('change', () => {
    // Credentials are never silently carried over to a different service format.
    f('key').value = ''; f('url').value = ''; f('model').value = ''; q('#tmv-models').replaceChildren();
    f('url').placeholder = f('provider').value === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://你的接口/v1';
    status('已切换接口格式，请填写对应地址、密钥和模型。');
});
f('url').addEventListener('change', () => { q('#tmv-models').replaceChildren(); });
for (const key of Object.keys(defaults)) f(key).addEventListener('change', () => { try { saveSettings(); } catch (e) { status(e.message, true); } });
f('file').addEventListener('change', async () => {
    try { const file = f('file').files[0]; const value = await readFile(file); if (value) load(value, file.name); }
    catch (e) { status(e.message, true); } finally { f('file').value = ''; }
});
f('draftfile').addEventListener('change', async () => {
    try {
        const draft = await readFile(f('draftfile').files[0]);
        if (!draft) return;
        if (draft.type !== MODULE || draft.version !== 1 || !Array.isArray(draft.plans)) throw new Error('不是受支持的审核草稿。');
        const parsed = parsePreset(draft.preset), restored = new Map();
        for (const entry of draft.plans) {
            if (!Array.isArray(entry) || entry.length !== 2) throw new Error('草稿条目格式错误。');
            const [i, saved] = entry;
            if (!Number.isInteger(i) || !parsed.prompts[i] || !Array.isArray(saved) || restored.has(i)) throw new Error('草稿条目索引不正确。');
            const fresh = planText(parsed.prompts[i].content ?? '', `p${i}`);
            if (fresh.length !== saved.length) throw new Error('草稿结构与原预设不一致。');
            fresh.forEach((p, j) => {
                if (!saved[j] || p.raw !== saved[j].raw || p.id !== saved[j].id) throw new Error('草稿文本与原预设不一致。');
                if (p.id && Array.isArray(saved[j].variants) && saved[j].variants.length) {
                    if (saved[j].variants.length > 8) throw new Error('草稿变体数量过多。');
                    p.variants = validateVariants(p.original, saved[j].variants, saved[j].variants.length);
                    p.approved = saved[j].approved === true;
                }
                if (p.id && typeof saved[j].error === 'string') p.error = saved[j].error.slice(0, 300);
            });
            restored.set(i, fresh);
        }
        load(parsed, typeof draft.presetName === 'string' ? draft.presetName : '预设');
        plans = restored;
        selected = new Set((Array.isArray(draft.selected) ? draft.selected : []).filter(i => Number.isInteger(i) && preset.prompts[i] && ensurePlan(i).some(p => p.id)));
        f('includeOriginal').checked = draft.includeOriginal !== false;
        renderEntries(); status('草稿已恢复，可以继续生成和审核。');
    } catch (e) { status(e.message, true); } finally { f('draftfile').value = ''; }
});

function init() {
    if (document.getElementById('tmv-launch')) return;
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host) { console.warn('[同义随机宏工坊] 未找到扩展面板。'); return; }
    const box = el('div', 'tmv-launchbox'), launch = el('button', 'menu_button', '🍑 打开同义随机宏工坊');
    launch.id = 'tmv-launch'; launch.type = 'button';
    box.append(launch); host.append(box);
    const dialog = el('dialog', 'tmv-dialog'); dialog.append(panel); document.body.append(dialog);
    launch.addEventListener('click', () => dialog.showModal());
    // Escape hides the panel; an explicit Stop button controls ongoing requests.
    dialog.addEventListener('close', () => { if (busy) globalThis.toastr?.info?.('工坊已收起，生成仍在继续；重新打开可查看或停止。'); });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
