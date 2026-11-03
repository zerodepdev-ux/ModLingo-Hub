'use strict';

const fs = require('fs');

/**
 * In-memory JSON file cache invalidated by mtime.
 */
function createJsonFileCache(filePath, defaultValue = {}) {
    let data = null;
    let mtimeMs = 0;

    return {
        load() {
            try {
                const stat = fs.statSync(filePath);
                if (data !== null && stat.mtimeMs === mtimeMs) return data;
                data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                mtimeMs = stat.mtimeMs;
            } catch {
                if (data === null) data = typeof defaultValue === 'function' ? defaultValue() : defaultValue;
            }
            return data;
        },
        save(value) {
            const json = JSON.stringify(value, null, 2) + '\n';
            fs.writeFileSync(filePath, json, 'utf8');
            try {
                mtimeMs = fs.statSync(filePath).mtimeMs;
            } catch {
                mtimeMs = 0;
            }
            data = value;
        },
        invalidate() {
            data = null;
            mtimeMs = 0;
        },
    };
}

module.exports = { createJsonFileCache };
