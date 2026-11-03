'use strict';

/**
 * Run async mapper over items with a concurrency limit.
 * @returns {Promise<Array>} results in the same order as items
 */
async function mapLimit(items, limit, mapper) {
    const results = new Array(items.length);
    let next = 0;

    async function worker() {
        while (next < items.length) {
            const i = next++;
            results[i] = await mapper(items[i], i);
        }
    }

    const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

module.exports = { mapLimit };
