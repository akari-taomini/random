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
 <section class="tmv-card tmv-welcome">
  <h3>给同一句话准备几种说法</h3>
  <p>选中预设里的提示词，让 AI 换几种意思相近的表达。导回酒馆后，每次聊天会随机选一种。</p>
  <p class="tmv-note">制作新说法时需要调用 AI；以后聊天时随机抽取，不会额外调用一次改写 AI。</p>
  <details data-v="tutorial"><summary>第一次用？点这里看教程和例子</summary>
   <h4>举个普通句子的例子</h4>
   <p>原来只有这一句：</p>
   <blockquote>请使用中文回答问题，并尽量表达得简洁清楚。</blockquote>
   <p>让 AI 另外写 3 种说法，例如：</p>
   <ul><li>回答问题时请用中文，尽量把话说得简洁明白。</li><li>请以中文作答，表达尽量简洁易懂。</li><li>请用中文回答问题，并尽量做到言简意明。</li></ul>
   <p>保留原文后，一共就有 4 种说法。导入新预设后，酒馆每次会随机挑一种发送；也可能连续抽到同一种。</p>
   <p class="tmv-note">这里只是文字示例。展开教程不会调用 API，也不会改动你的预设。</p>
   <h4>第一次用，照着这 4 步做</h4>
   <ol class="tmv-tutorial-steps">
    <li><b>选谁来改写：</b>在第 1 步选酒馆已经保存好的 API 连接。没看到？先去酒馆的“API 连接”面板保存一个“连接预设”，再回来点“更新列表”。其他设置先保持默认。</li>
    <li><b>选要改的文字：</b>在第 2 步点“读取酒馆当前预设”，勾选想处理的提示词。这里的“条目”就是预设列表里的一条提示词。初次使用可以只勾一项试试。</li>
    <li><b>生成并选用：</b>点“开始生成新说法”。完成后查看结果，满意就点“全部用上”；也可以逐段勾选“用这一组新说法”。</li>
    <li><b>拿回酒馆使用：</b>点“下载改好的预设”。回到酒馆的“对话补全预设”面板，点导入，选择刚下载的文件，再选中这个新预设开始聊天。</li>
   </ol>
   <p class="tmv-note">上面选的 API 是“谁来改写”，下面读取的预设是“要改哪些文字”，这两个选择可以不同。</p>
   <details><summary>数量、合并、RPM 分别是什么意思？</summary>
    <p><b>新说法数量：</b>填 3 就是让 AI 另写 3 种；如果保留原文，最后共有 4 种。</p>
    <p><b>一次合并几段：</b>把多段文字一起发给 AI，减少请求次数。例如 20 个短段落、每次合并 5 段，通常只需 4 次请求。文字较长时会自动少放几段。</p>
    <p><b>每分钟最多请求几次（RPM）：</b>接口规定的请求频率。知道自己的限制就按额度填写，并给聊天留些余量；不清楚可以先用默认的 10。填 0 会关闭本工坊的限速。</p>
   </details>
   <details><summary>为什么有些提示词不能勾选？</summary><p>包含已有随机选项、宏变量、代码、标签或短标题的文字，会原样保留。灰色项可以跳过，不需要强行改写。</p></details>
   <details><summary>生成失败或暂时不想做完怎么办？</summary><p>失败时先看提示，检查所选 API 能否正常使用，再点“只重试失败的”。想下次继续，就先点第 4 步的“保存进度”；下次打开插件，点“继续上次进度”选择这个文件。</p></details>
  </details>
 </section>
 <details class="tmv-card" open><summary>① 选一个帮你改写的 AI</summary>
  <p class="tmv-note">酒馆已经配好 API 的话，直接用第一项，再选择保存好的连接即可。</p>
  <div class="tmv-grid">
   <label class="tmv-wide">用哪个 AI？<select data-f="provider"><option value="st-profile">用酒馆里保存好的 API（推荐）</option><option value="openai">另外填写 API · OpenAI 兼容格式</option><option value="gemini">另外填写 API · Gemini 原生格式</option></select></label>
   <div class="tmv-wide" data-mode="profile"><label>选一个已保存的 API 连接<div class="tmv-row"><select data-f="profileId"><option value="">请选择连接预设</option></select><button type="button" data-a="profiles">更新列表</button></div></label><p data-v="profile-info" class="tmv-note"></p></div>
   <label class="tmv-wide" data-mode="direct">接口地址（API URL）<input data-f="url" type="url" placeholder="例如 https://你的接口/v1" autocomplete="off"><small class="tmv-helptext">填服务商给你的完整地址。OpenAI 兼容接口常以 /v1 结尾，插件不会自动补上。</small></label>
   <label class="tmv-wide" data-mode="direct">接口密钥（API Key）<input data-f="key" type="password" placeholder="填写这个接口对应的密钥" autocomplete="off"><small class="tmv-helptext">刷新页面后会清空，需要重新填写。</small></label>
   <label class="tmv-wide" data-mode="direct">用哪个模型？<div class="tmv-row"><input data-f="model" list="tmv-models" placeholder="填模型名称，或点右边获取"><button type="button" data-a="models">获取模型列表</button></div><datalist id="tmv-models"></datalist><small class="tmv-helptext">这里填接口支持的模型 ID，不是角色名字。</small></label>
  </div>
  <p data-v="option-summary" class="tmv-note"></p>
  <details data-v="generation-options"><summary>可选：调整数量和速度（不懂先不改）</summary><div class="tmv-grid">
   <label>每段另外写几种说法？<input data-f="count" type="number" min="1" max="8" value="3"><small class="tmv-helptext">填 3 表示新增 3 种，不包含原来的句子。</small></label>
   <label>一次合并几段发送？<input data-f="batchSize" type="number" min="1" max="50" value="5"><small class="tmv-helptext">默认 5，减少请求次数。长段落会自动少合并一些。</small></label>
   <label class="tmv-wide">每分钟最多请求几次？（RPM）<input data-f="rpm" type="number" min="0" max="600" value="10"><small class="tmv-helptext">默认 10。按你的接口额度调整；填 0 表示不限。这里只计算本工坊，聊天和其他插件还会占用额度。</small></label>
  </div><label class="tmv-check"><input data-f="includeOriginal" type="checkbox" checked>原来的句子也保留，和新说法一起随机选</label></details>
  <p data-v="api-note" class="tmv-note"></p>
  <details><summary>高级：给改写 AI 的要求（一般不用改）</summary><p class="tmv-note">这是插件告诉 AI“应该怎么改写”的说明，已经内置好了。</p><textarea data-f="prompt" rows="10" spellcheck="false"></textarea><button type="button" data-a="reset-prompt">恢复默认要求</button></details>
 </details>
 <section class="tmv-card"><h3>② 选要改写的提示词</h3>
  <p class="tmv-note">先读取一份预设，再勾选想处理的提示词。只想改一部分，就只勾那几项。</p>
  <div class="tmv-row tmv-wrap"><button type="button" data-a="current">读取酒馆当前预设</button><button type="button" data-a="upload">从 JSON 文件读取</button><input type="file" data-f="file" accept=".json,application/json" hidden></div>
  <p data-v="source" class="tmv-note">还没有读取预设。先点上面的“读取酒馆当前预设”。</p>
  <div class="tmv-row"><input data-f="search" placeholder="输入提示词名称来查找" aria-label="查找提示词名称"><button type="button" data-a="all">勾选当前列表</button><button type="button" data-a="none">取消勾选</button></div>
  <div data-v="entries" class="tmv-entries"></div>
  <p data-v="selection" class="tmv-note">已勾选 0 条提示词</p>
 </section>
 <section class="tmv-card"><h3>③ 生成新说法，选出你想用的</h3>
  <div class="tmv-row tmv-wrap"><button type="button" data-a="generate" class="tmv-primary">开始生成新说法</button><button type="button" data-a="retry">只重试失败的</button><button type="button" data-a="stop" disabled>停止生成</button></div>
  <p data-v="status" class="tmv-status" role="status" aria-live="polite">准备好后点“开始生成新说法”。灰色提示词和需要保护的格式会原样保留。</p>
  <progress data-v="progress" max="1" value="0"></progress>
  <div class="tmv-row"><label class="tmv-grow">查看哪一项的结果？<select data-f="preview"></select></label></div>
  <div class="tmv-row tmv-wrap"><button type="button" data-a="approve-all">全部用上</button><button type="button" data-a="unapprove-all">取消全部选用</button></div>
  <p class="tmv-note">“全部用上”会选用所有已成功生成的结果，不只当前这一项。也可逐段勾选“用这一组新说法”；没选用的部分继续保留原文。检查不通过的结果会跳过。</p>
  <div data-v="review"></div>
 </section>
 <section class="tmv-card"><h3>④ 下载，再导回酒馆使用</h3>
  <label>下载后叫什么名字？<input data-f="filename" placeholder="预设名-同义随机宏"></label>
  <div class="tmv-row tmv-wrap"><button type="button" data-a="export" class="tmv-primary">下载改好的预设</button><button type="button" data-a="draft">保存进度</button><button type="button" data-a="load-draft">继续上次进度</button><input type="file" data-f="draftfile" accept=".json,application/json" hidden></div>
  <p class="tmv-note">下载后，回到酒馆的“对话补全预设”面板，点导入并选择这个 JSON 文件，再选中它使用。只下载文件还不会自动生效。</p>
  <p class="tmv-note">“保存进度”是留着下次继续改的文件。下次点“继续上次进度”读取它；它不是直接拿去聊天的预设。</p>
 </section>
 <footer class="tmv-note">桃mini & GPT · v1.3.0 · 欢迎标注作者后二改与分享，非商业使用。</footer>
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
    if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error('每段新说法的数量请填 1～8 的整数。');
    if (!f('includeOriginal').checked && count < 2) throw new Error('不保留原文时，请至少生成 2 种新说法，才能随机选择。');
    const batchSize = Number(f('batchSize').value), rpm = Number(f('rpm').value);
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) throw new Error('每批段落数应为 1～50 的整数。');
    if (!f('rpm').value.trim() || !Number.isInteger(rpm) || rpm < 0 || rpm > 600) throw new Error('RPM 上限应为 0～600 的整数，0 表示不限。');
    return { provider: f('provider').value, profileId: f('profileId').value, url: f('url').value.trim(), model: f('model').value.trim(), key: f('key').value.trim(), count, batchSize, rpm, includeOriginal: f('includeOriginal').checked, prompt: f('prompt').value };
}

function showGenerationSummary() {
    const count = Number(f('count').value), batch = Number(f('batchSize').value), rpm = Number(f('rpm').value);
    if (!Number.isInteger(count) || count < 1 || count > 8 || !Number.isInteger(batch) || batch < 1 || batch > 50 || !f('rpm').value.trim() || !Number.isInteger(rpm) || rpm < 0 || rpm > 600) {
        v('option-summary').textContent = '设置还没填完，填好后再开始生成。'; return;
    }
    const choices = f('includeOriginal').checked ? `，加上原文共 ${count + 1} 种` : '，不保留原文';
    v('option-summary').textContent = `当前设置：每段新增 ${count} 种说法${choices}。每次最多合并 ${batch} 段；${rpm ? `每分钟最多请求 ${rpm} 次` : '未开启请求限速'}。`;
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
            const missing = el('option', '', '原来的连接找不到了，请重新选择'); missing.value = previous; f('profileId').append(missing);
        }
        f('profileId').value = previous || '';
        showProfileInfo();
    } catch (error) { profiles = []; v('profile-info').textContent = error.message; }
}

function showProfileInfo() {
    const profile = profiles.find(p => p.id === f('profileId').value);
    v('profile-info').textContent = profile
        ? `将使用“${profile.name}”中的模型：${profile.model}。想换模型，请先在酒馆修改这个连接，再回来更新列表。`
        : profiles.length ? '选一个平时能正常使用的连接。这里选的是“谁来改写”，第 2 步才选择“要改哪些文字”。'
            : '还没找到保存好的连接。先去酒馆“API 连接”面板配好接口，保存为“连接预设”，再回来点“更新列表”。';
}

function showApiMode() {
    const useProfile = f('provider').value === 'st-profile';
    panel.querySelectorAll('[data-mode]').forEach(node => { node.hidden = useProfile ? node.dataset.mode !== 'profile' : node.dataset.mode !== 'direct'; });
    v('api-note').textContent = useProfile
        ? '不用重填密钥，也不会切换你聊天时正在使用的连接。生成新说法会使用这个接口的额度。'
        : '会把选中的文字发给这个接口改写，并使用它的额度。接口需支持浏览器直接访问（CORS）；若连接失败，可以改用酒馆里保存好的 API。';
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
    v('source').textContent = `${presetName} · ${preset.prompts.length} 条提示词`;
    renderEntries(); renderReview();
    status('预设已读取。下一步：在第 2 步勾选要处理的提示词，再点“开始生成新说法”。');
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
        row.append(checkbox, title, el('span', 'tmv-badge', count ? `${count} 段` : '原样保留'));
        row.title = count ? `这项里有 ${count} 段文字可以生成新说法。` : '这项的文字或格式需要保留，不用勾选。';
        row.dataset.index = i;
        v('entries').append(row);
    });
    renderSelection();
}

function renderSelection() {
    const count = [...selected].reduce((n, i) => n + ensurePlan(i).filter(p => p.id).length, 0);
    v('selection').textContent = `已勾选 ${selected.size} 条提示词，包含 ${count} 段可改写文字`;
    try {
        const pending = [...selected].flatMap(index => ensurePlan(index).filter(part => part.id && !part.variants.length).map(part => ({ part, index })));
        const batches = makeBatches(pending, Number(f('batchSize').value), Number(f('count').value));
        v('selection').textContent += ` · 还有 ${pending.length} 段没生成，预计请求 ${batches.length} 次（失败重试另算）`;
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
        const details = el('details'); details.append(el('summary', '', `这些内容会原样保留：${skipped.length} 行（点开看原因）`));
        for (const p of skipped) details.append(el('p', 'tmv-note', `${p.reason}：${p.raw.trim().slice(0, 100)}`));
        v('review').append(details);
    }
    for (const part of parts.filter(p => p.id)) {
        const card = el('div', 'tmv-unit');
        card.append(el('div', 'tmv-eyebrow', '原来的文字'), el('p', 'tmv-original', part.original));
        if (part.error) card.append(el('p', 'tmv-error', part.error));
        const inputs = [];
        part.variants.forEach((variant, j) => {
            const label = el('label', '', `新说法 ${j + 1}`), input = el('textarea');
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
        label.append(approve, document.createTextNode('用这一组新说法'));
        const retry = el('button', '', part.variants.length ? '再写一组' : '生成这一段'); retry.type = 'button';
        retry.addEventListener('click', () => run([{ part, index: activeIndex }]));
        const reset = el('button', '', '这段用原文'); reset.type = 'button';
        reset.addEventListener('click', () => { part.approved = false; approve.checked = false; });
        actions.append(label, retry, reset); card.append(actions); v('review').append(card);
    }
    const preview = el('details'), output = el('pre', 'tmv-output');
    preview.append(el('summary', '', '查看这一项最后会保存成什么'));
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
    if (!jobs.length) { status('没有需要生成的新内容。已有结果可以直接选用；想重新写，点对应段落的“再写一组”。'); return; }
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
        status(`${controller.signal.aborted ? '已停止' : '生成完成'}：处理 ${done}/${jobs.length} 段，失败 ${failed} 段，共请求 ${attempts} 次。下一步：查看结果，满意就点“全部用上”，再下载预设。`);
    } catch (error) { status(controller.signal.aborted ? `已停止，保留已完成的结果（${done} 段）。` : error.message, !controller.signal.aborted); }
    finally { setBusy(false); renderEntries(); }
}

const handlers = {
    'approve-all'() {
        if (!preset) throw new Error('请先在第 2 步读取预设，再生成新说法。');
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
        status(adopted ? `已选用 ${adopted} 组新说法${invalid ? `，${invalid} 段校验未通过` : ''}。其余部分保留原文。下一步：点第 4 步的“下载改好的预设”。` : `还没有可选用的结果${invalid ? `，${invalid} 段校验未通过` : ''}。请先生成新说法，或重新生成失败的部分。`);
    },
    'unapprove-all'() {
        for (const parts of plans.values()) for (const part of parts) if (part.id) part.approved = false;
        renderReview(); status('已取消全部选用。新说法仍保留，想用时可以再勾选。');
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
            status(result.source === 'live' ? '已读取酒馆当前预设。下一步：勾选想处理的提示词，再点“开始生成新说法”。' : '已读取保存的版本。如果刚修改过提示词，请先在酒馆保存，再重新读取。');
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
        if (!preset || !selected.size) throw new Error('先到第 2 步读取预设，再勾选至少一条想处理的提示词。');
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
        if (!approved) throw new Error('还没选用生成结果。先点“全部用上”，或勾选“用这一组新说法”，再下载。');
        download(f('filename').value.trim() || `${presetName}-同义随机宏`, exportPreset(preset, plans, f('includeOriginal').checked));
        status(`已下载预设，其中 ${approved} 段使用了新说法。下一步：回酒馆“对话补全预设”面板，导入刚下载的文件并选中它。`);
    },
    draft() {
        if (!preset) throw new Error('请先读取预设。');
        download(`${presetName}-生成进度`, { type: MODULE, version: 1, preset, presetName, plans: [...plans], selected: [...selected], includeOriginal: f('includeOriginal').checked });
        status('进度文件已下载。下次点“继续上次进度”读取它，就能接着做。');
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
    if (f('provider').value === 'st-profile') { refreshProfiles(); status('在第 1 步选一个保存好的 API 连接，就能用它改写；不需要重填密钥。'); }
    else status('已切换接口格式，请填写对应地址、密钥和模型。');
});
f('profileId').addEventListener('change', showProfileInfo);
for (const name of ['batchSize', 'count']) f(name).addEventListener('input', renderSelection);
for (const name of ['count', 'batchSize', 'rpm']) f(name).addEventListener('input', showGenerationSummary);
f('includeOriginal').addEventListener('change', showGenerationSummary);
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
        if (draft.type !== MODULE || draft.version !== 1 || !Array.isArray(draft.plans)) throw new Error('这不是进度文件。请选择通过“保存进度”下载的 JSON。');
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
        showGenerationSummary(); renderEntries(); status('进度已恢复。可以接着生成、选择想用的新说法，然后下载预设。');
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
    refreshProfiles(); showApiMode(); showGenerationSummary();
    // Escape hides the panel; an explicit Stop button controls ongoing requests.
    dialog.addEventListener('close', () => { if (busy) globalThis.toastr?.info?.('工坊已收起，当前操作仍在继续；重新打开可查看。'); });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
