// Bound output growth as well as unit count. This is a character estimate,
// not a tokenizer guarantee; an oversized single unit remains indivisible.
export function makeBatches(jobs, size = 5, variantCount = 3, budget = 12000) {
    if (!Number.isInteger(size) || size < 1 || size > 50) throw new Error('每批段落数应为 1～50 的整数。');
    if (!Number.isInteger(variantCount) || variantCount < 1 || variantCount > 8) throw new Error('新增变体数应为 1～8 的整数。');
    const batches = [];
    let batch = [], cost = 0;
    for (const job of jobs) {
        const estimate = Math.ceil(job.part.original.length * (1 + variantCount * 1.4)) + 200;
        if (batch.length && (batch.length >= size || cost + estimate > budget)) {
            batches.push(batch); batch = []; cost = 0;
        }
        batch.push(job); cost += estimate;
    }
    if (batch.length) batches.push(batch);
    return batches;
}

export function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(signal.reason); return; }
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
        signal?.addEventListener('abort', abort, { once: true });
    });
}

// One shared pacer survives Generate/Retry/Regenerate runs in this page. Failed
// attempts count too; a new click cannot bypass the configured start spacing.
export class RequestPacer {
    constructor({ now = () => performance.now(), wait = sleep } = {}) {
        this.now = now; this.wait = wait; this.lastStarted = -Infinity; this.blockedUntil = 0;
    }
    defer(ms) { this.blockedUntil = Math.max(this.blockedUntil, this.now() + Math.max(0, ms)); }
    async beforeRequest(rpm, signal, onWait = () => {}) {
        if (!Number.isInteger(rpm) || rpm < 0 || rpm > 600) throw new Error('RPM 上限应为 0～600 的整数，0 表示不限。');
        const spacing = rpm ? 60000 / rpm + 20 : 0;
        while (true) {
            if (signal?.aborted) throw signal.reason;
            const remaining = Math.max(this.blockedUntil, this.lastStarted + spacing) - this.now();
            if (remaining <= 0) break;
            onWait(remaining);
            await this.wait(Math.min(1000, remaining), signal);
        }
        this.lastStarted = this.now();
    }
}
