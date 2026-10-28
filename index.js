import { DEFAULT_PROMPT, parsePreset, planText, generate, listModels, exportPreset, renderPlan, validateVariants, endpoint } from './core.js';
import { getProfiles, requireProfile, generateWithProfile } from './st-api.js';
import { makeBatches, RequestPacer } from './batch.js';
import { readCurrentChatPreset } from './preset-reader.js';

const MODULE = 'taomini_preset_variants';
const defaults = { provider: 'st-profile', profileId: '', url: '', model: '', count: 3, batchSize: 5, rpm: 10, includeOriginal: true, prompt: DEFAULT_PROMPT };
const pacer = new RequestPacer();
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
   <label>改写来源<select data-f="provider"><option value="st-profile">酒馆 API 连接预设</option><option value="openai">单独填写 · OpenAI 兼容</option><option value="gemini">单独填写 · Gemini 原生</option></select></label>
   <label>新增变体数（不含原文）<input data-f="count" type="number" min="1" max="8" value="3"></label>
   <label>每批合并段落数<input data-f="batchSize" type="number" min="1" max="50" value="5"></label>
   <label>请求 RPM 上限（0 表示不限）<input data-f="rpm" type="number" min="0" max="600" value="10"></label>
   <p class="tmv-note tmv-wide">默认每批最多 5 段、每分钟最多 10 次生成请求。较长段落会自动减少同批数量；重试也计入请求间隔。这里的限速仅控制本工坊，其他聊天请求仍占用接口额度。</p>
   <div class="tmv-wide" data-mode="profile"><label>酒馆 API 连接预设<div class="tmv-row"><select data-f="profileId"><option value="">请选择连接预设</option></select><button type="button" data-a="profiles">刷新列表</button></div></label><p data-v="profile-info" class="tmv-note"></p></div>
   <label class="tmv-wide" data-mode="direct">API 基础地址<input data-f="url" type="url" placeholder="https://你的接口/v1" autocomplete="off"></label>
   <label class="tmv-wide" data-mode="direct">API Key<input data-f="key" type="password" placeholder="仅在本次页面内使用，刷新后清空" autocomplete="off"></label>
   <label class="tmv-wide" data-mode="direct">模型<div class="tmv-row"><input data-f="model" list="tmv-models" placeholder="填写模型 ID"><button type="button" data-a="models">拉取模型</button></div><datalist id="tmv-models"></datalist></label>
  </div>
  <label class="tmv-check"><input data-f="includeOriginal" type="checkbox" checked>把原文也放入随机选项</label>
  <p data-v="api-note" class="tmv-note"></p>
  <details><summary>内置改写提示词 · 可编辑</summary><textarea data-f="prompt" rows="10" spellcheck="false"></textarea><button type="button" data-a="reset-prompt">恢复默认提示词</button></details>
 </details>
 <section class="tmv-card"><h3>② 选择预设条目</h3>
  <div class="tmv-row tmv-wrap"><button type="button" data-a="current">读取当前对话补全预设</button><button type="button" data-a="upload">上传预设 JSON</button><input type="file" data-f="file" accept=".json,application/json" hidden></div>
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
  <div class="tmv-row tmv-wrap"><button type="button" data-a="approve-all">一键采用全部已生成段落</button><button type="button" data-a="unapprove-all">取消全部采用</button></div>
  <p class="tmv-note">可以逐段勾选“采用此段”，也可一键采用当前工作区全部已生成且校验通过的段落（跨条目）。失败或未采用的段落保留原文。</p>
  <div data-v="review"></div>
 </section>
 <section class="tmv-card"><h3>④ 导出新预设</h3>
  <label>新预设文件名<input data-f="filename" placeholder="预设名-同义随机宏"></label>
  <div class="tmv-row tmv-wrap"><button type="button" data-a="export" class="tmv-primary">导出已审核预设</button><button type="button" data-a="draft">保存审核草稿</button><button type="button" data-a="load-draft">恢复草稿</button><input type="file" data-f="draftfile" accept=".json,application/json" hidden></div>
  <p class="tmv-note">导出为新 JSON；到酒馆预设面板导入即可。草稿包含原预设和生成进度，方便下次接着审核。</p>
 </section>
 <footer class="tmv-note">桃mini & GPT · v1.2.1 · 欢迎标注作者后二改与分享，非商业使用。</footer>
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
    const batchSize = Number(f('batchSize').value), rpm = Number(f('rpm').value);
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) throw new Error('每批段落数应为 1～50 的整数。');
    if (!f('rpm').value.trim() || !Number.isInteger(rpm) || rpm < 0 || rpm > 600) throw new Error('RPM 上限应为 0～600 的整数，0 表示不限。');
    return { provider: f('provider').value, profileId: f('profileId').value, url: f('url').value.trim(), model: f('model').value.trim(), key: f('key').value.trim(), count, batchSize, rpm, includeOriginal: f('includeOriginal').checked, prompt: f('prompt').value };
}

let profiles = [];
// Retain a deleted/missing selection visibly; never silently choose a different API.
function refreshProfiles() {
    const previous = f('profileId').value || settings.profileId;
    f('profileId').replaceChildren();
    const empty = el('option', '', '请选择连接预设'); empty.value = ''; f('profileId').append(empty);
    try {
        profiles = getProfiles(ctx());
        for (const profile of profiles) {
            const option = el('option', '', `${profile.name} · ${profile.model}`); option.value = profile.id; f('profileId').append(option);
        }
        if (previous && !profiles.some(p => p.id === previous)) {
            const missing = el('option', '', '先前选择已不可用，请重新选择'); missing.value = previous; f('profileId').append(missing);
        }
        f('profileId').value = previous || '';
        showProfileInfo();
    } catch (error) { profiles = []; v('profile-info').textContent = error.message; }
}

function showProfileInfo() {
    const profile = profiles.find(p => p.id === f('profileId').value);
    v('profile-info').textContent = profile
        ? `模型：${profile.model} · API：${profile.api}。使用此连接保存的地址、密钥和生成设置。`
        : profiles.length ? '请选择一个有效的连接预设。这里的连接预设与下方要改写的聊天补全预设是两个不同的选择。'
            : '没有可用的连接预设。请先在酒馆“API 连接 → 连接预设”中保存一个连接，再刷新列表。';
}

function showApiMode() {
    const useProfile = f('provider').value === 'st-profile';
    panel.querySelectorAll('[data-mode]').forEach(node => { node.hidden = useProfile ? node.dataset.mode !== 'profile' : node.dataset.mode !== 'direct'; });
    v('api-note').textContent = useProfile
        ? '经酒馆后台使用所选连接，无需重填密钥；不切换当前聊天连接。只发送改写提示词和选中的文本。'
        : '只将选中且适合改写的文本发给此接口。密钥不写入预设或插件设置；接口需支持浏览器跨域请求。';
}

function saveSettings() {
    const current = ctx();
    if (!current?.extensionSettings) return;
    const conf = config();
    delete conf.key;
    settings.profileId = conf.profileId;
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
    try {
        const pending = [...selected].flatMap(index => ensurePlan(index).filter(part => part.id && !part.variants.length).map(part => ({ part, index })));
        const batches = makeBatches(pending, Number(f('batchSize').value), Number(f('count').value));
        v('selection').textContent += ` · 待生成 ${pending.length} 段，预计 ${batches.length} 次请求（不含重试）`;
    } catch { /* Keep the existing count while a numeric field is being edited. */ }
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

async function run(jobs) {
    if (busy) return;
    let conf;
    try {
        conf = { ...config(), partialResults: true };
        if (conf.provider === 'st-profile') conf.sourceLabel = requireProfile(ctx(), conf.profileId).name;
        else { if (!conf.url || !conf.model) throw new Error('先填写 API 地址和模型。'); endpoint(conf); }
        saveSettings();
    }
    catch (error) { status(error.message, true); return; }
    if (!jobs.length) { status('没有待处理的段落。'); return; }
    const batches = makeBatches(jobs, conf.batchSize, conf.count);
    // Config is captured once: changing UI cannot alter a running job.
    controller = new AbortController(); setBusy(true);
    let done = 0, failed = 0, attempts = 0;
    v('progress').max = jobs.length; v('progress').value = 0;
    try {
        for (const [batchIndex, batch] of batches.entries()) {
            if (controller.signal.aborted) break;
            const label = `批次 ${batchIndex + 1}/${batches.length} · 本批 ${batch.length} 段 · 已处理 ${done}/${jobs.length} 段${conf.sourceLabel ? ' · 连接：' + conf.sourceLabel : ''}`;
            let result;
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    await pacer.beforeRequest(conf.rpm, controller.signal, remaining => {
                        status(`等待 ${Math.ceil(remaining / 1000)} 秒后发送 · ${label} · RPM 上限 ${conf.rpm || '不限'}`);
                    });
                    status(`正在生成 · ${label}${attempt ? ' · 重试' : ''}`);
                    for (const { part } of batch) part.approved = false;
                    attempts++;
                    const units = batch.map(({ part }) => ({ id: part.id, text: part.original }));
                    result = conf.provider === 'st-profile'
                        ? await generateWithProfile(conf, units, conf.count, controller.signal, ctx())
                        : await generate(conf, units, conf.count, controller.signal);
                    break;
                } catch (error) {
                    if (controller.signal.aborted) throw error;
                    if (error.retryable) pacer.defer(error.rateLimited ? Math.max(1000, error.retryAfterMs ?? 60000) : 1800);
                    if (attempt === 0 && error.retryable) continue;
                    for (const { part } of batch) part.error = error.message;
                    failed += batch.length;
                    if (error.fatal) throw error;
                    break;
                }
            }
            if (result) {
                for (const { part } of batch) {
                    const outcome = result.find(r => r.id === part.id);
                    if (outcome?.variants) { part.variants = outcome.variants; part.error = ''; }
                    else { part.error = outcome?.error || 'API 未返回该段结果。'; failed++; }
                }
            }
            done += batch.length; v('progress').value = done;
            if (batch.some(job => job.index === activeIndex)) renderReview();
        }
        status(`${controller.signal.aborted ? '已停止' : '生成完成'}：处理 ${done}/${jobs.length} 段，失败 ${failed} 段，共请求 ${attempts} 次。请审核后采用。`);
    } catch (error) { status(controller.signal.aborted ? `已停止，保留已完成的结果（${done} 段）。` : error.message, !controller.signal.aborted); }
    finally { setBusy(false); renderEntries(); }
}

const handlers = {
    'approve-all'() {
        if (!preset) throw new Error('请先读取预设并生成变体。');
        let adopted = 0, invalid = 0;
        for (const parts of plans.values()) for (const part of parts) {
            if (!part.id) continue;
            part.approved = false;
            if (!part.variants.length || part.error) continue;
            try {
                validateVariants(part.original, part.variants, part.variants.length);
                part.approved = true; adopted++;
            } catch (error) { part.error = error.message; invalid++; }
        }
        renderReview();
        status(`已采用 ${adopted} 个已生成段落${invalid ? `，${invalid} 段校验未通过` : ''}。失败或未生成的段落保留原文；现在可以导出预设。`);
    },
    'unapprove-all'() {
        for (const parts of plans.values()) for (const part of parts) if (part.id) part.approved = false;
        renderReview(); status('已取消全部采用，变体仍保留，可以重新选择。');
    },
    profiles() { refreshProfiles(); },
    close() { panel.closest('dialog')?.close(); },
    async current() {
        if (busy) return;
        setBusy(true); a('stop').disabled = true;
        status('正在读取当前对话补全预设…');
        try {
            const result = await readCurrentChatPreset({ context: ctx() });
            load(result.preset, result.name);
            v('source').textContent += result.source === 'live' ? ' · 当前界面状态（含未保存修改）' : ' · 已保存版本';
            status(result.source === 'live' ? '已读取当前对话补全预设，请勾选需要改写的条目。' : '已读取保存的预设版本；当前界面状态不可用，请确认修改已保存。');
        } finally { setBusy(false); renderEntries(); }
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
    showApiMode();
    if (f('provider').value === 'st-profile') { refreshProfiles(); status('请选择酒馆 API 连接预设，无需重复填写密钥。'); }
    else status('已切换接口格式，请填写对应地址、密钥和模型。');
});
f('profileId').addEventListener('change', showProfileInfo);
for (const name of ['batchSize', 'count']) f(name).addEventListener('input', renderSelection);
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
    launch.addEventListener('click', () => { if (!busy) { refreshProfiles(); showApiMode(); } dialog.showModal(); });
    refreshProfiles(); showApiMode();
    // Escape hides the panel; an explicit Stop button controls ongoing requests.
    dialog.addEventListener('close', () => { if (busy) globalThis.toastr?.info?.('工坊已收起，当前操作仍在继续；重新打开可查看。'); });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
