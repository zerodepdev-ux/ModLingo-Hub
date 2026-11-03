'use strict';

const SSE_HEADERS = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
};

function flushSse(res) {
    if (typeof res.flush === 'function') {
        try { res.flush(); } catch {}
    }
}

/**
 * @param {import('http').ServerResponse} res
 * @param {{ typed?: boolean }} [opts] typed=true → `data: { type, ... }` (BG3-style)
 */
function openSse(res, opts) {
    const typed = !!(opts && opts.typed);
    res.writeHead(200, SSE_HEADERS);
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    try { res.write(': ok\n\n'); } catch {}
    flushSse(res);

    const send = (event, data) => {
        try {
            if (typed) {
                res.write(`data: ${JSON.stringify({ type: event, ...data })}\n\n`);
            } else {
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            }
            flushSse(res);
        } catch {}
    };
    return send;
}

module.exports = { SSE_HEADERS, openSse, flushSse };
