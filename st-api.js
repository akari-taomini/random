import { DEFAULT_PROMPT, parseReply, parseBatchReply } from './core.js';

const fatal = message => Object.assign(new Error(message), { fatal: true });

function serviceFor(context) {
    if (context?.extensionSettings?.disabledExtensions?.includes('connection-manager')) {
        throw fatal('酒馆的“连接预设（Connection Profiles）”扩展未启用，请先在扩展管理中启用。');
    }
    const service = context?.ConnectionManagerRequestService;
    if (typeof service?.getSupportedProfiles !== 'function' || typeof service?.sendRequest !== 'function') {
        throw fatal('当前酒馆未提供连接预设请求接口，请更新酒馆，或使用单独填写 API 的方式。');
    }
    return service;
}

/** Only public display metadata leaves this adapter; never copy stored secrets. */
export function getProfiles(context) {
    const service = serviceFor(context);
    let profiles;
    try { profiles = service.getSupportedProfiles(); }
    catch { throw fatal('无法读取酒馆连接预设，请确认“连接预设”扩展已启用且配置有效。'); }
    if (!Array.isArray(profiles)) throw fatal('酒馆返回的连接预设列表格式不正确。');
    return profiles.filter(p => p && typeof p.id === 'string' && p.id).map(p => ({
        id: p.id, name: String(p.name || p.id), model: String(p.model || '预设默认模型'), api: String(p.api || ''),
    }));
}

export function requireProfile(context, id) {
    if (!id) throw fatal('请先选择一个酒馆 API 连接预设。');
    const profile = getProfiles(context).find(p => p.id === id);
    if (!profile) throw fatal('所选连接预设已被删除或不受支持，请刷新连接列表后重新选择。');
    return profile;
}

function requestError(error) {
    // ST may wrap provider errors in Error.cause. Do not display raw provider
    // bodies: those can contain credentials, internal URLs or request payloads.
    const messages = [];
    const seen = new Set();
    for (let current = error; current && !seen.has(current) && seen.size < 5; current = current.cause) {
        seen.add(current); messages.push(String(current.message || ''));
    }
    const detail = messages.join(' ');
    if (/\b(?:401|403)\b/.test(detail)) return fatal('酒馆连接鉴权失败，请在该连接预设中检查密钥和访问权限。');
    if (/\b(?:429|5\d\d)\b/.test(detail)) return Object.assign(new Error('酒馆连接限流或服务暂时不可用，将按队列规则重试。'), { retryable: true, rateLimited: /\b429\b/.test(detail) });
    return fatal('酒馆连接请求失败，请检查该连接预设的 API、模型、密钥及网络；生成队列已停止。');
}

export async function generateWithProfile(config, units, count, signal, context) {
    requireProfile(context, config.profileId);
    const service = serviceFor(context);
    const messages = [
        { role: 'system', content: config.prompt?.trim() || DEFAULT_PROMPT },
        { role: 'user', content: JSON.stringify({ variant_count: count, units }) },
    ];
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason ?? new DOMException('已停止', 'AbortError'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('酒馆连接请求超时（120 秒）')), 120000);
    let response;
    try {
        if (controller.signal.aborted) throw controller.signal.reason;
        response = await service.sendRequest(config.profileId, messages, 16384, {
            stream: false, signal: controller.signal, extractData: true,
            includePreset: true, includeInstruct: true,
        });
        if (controller.signal.aborted) throw controller.signal.reason;
    } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw requestError(error);
    } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
    }
    const text = typeof response === 'string' ? response : response?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('酒馆连接没有返回文本，可能被拦截或输出为空。');
    return (config.partialResults ? parseBatchReply : parseReply)(text, units, count);
}
