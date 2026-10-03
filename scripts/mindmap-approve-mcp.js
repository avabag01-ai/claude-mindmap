#!/usr/bin/env node
/**
 * mindmap-approve-mcp.js
 * =============================================================================
 * 마인드맵 대화창에서 보낸 claude 가 "이 도구 써도 돼요?" 를 물을 때 쓰는 MCP 서버 (stdio).
 * 클로드 앱처럼 화면에 허용 / 거절 창을 띄우려고 만든 것.
 *
 * 앱이 claude 를 이렇게 띄운다 (등록할 필요 없음):
 *   claude -p --mcp-config '{"mcpServers":{"mindmap-approve":{...이 파일...}}}' --permission-prompt-tool mcp__mindmap-approve__approve
 *
 * 주고받기는 파일로 한다 (~/.claude-mindmap/approvals):
 *   <id>.req.json  { id, runId, tool, input, cwd, at }   ← 이 서버가 쓴다
 *   <id>.ans.json  { allow: true|false, message? }       ← 앱이 쓴다 (화면에서 고른 것)
 * 10분 안에 답이 없으면 거절.
 *
 * 의존성 없음: MCP 는 줄 단위 JSON-RPC 2.0 이라 직접 처리한다.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const VERSION = '1.0.0';
const DIR = require('../src/core/appDir.js').settingsFile('approvals');
const WAIT_MS = 10 * 60 * 1000;

function writeAtomic(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
}

/** 화면에 묻고 답을 기다린다 → { behavior: 'allow', updatedInput } 또는 { behavior: 'deny', message } */
async function ask(toolName, input) {
    fs.mkdirSync(DIR, { recursive: true });
    const id = crypto.randomUUID();
    const req = path.join(DIR, id + '.req.json');
    const ans = path.join(DIR, id + '.ans.json');
    writeAtomic(req, { id, runId: process.env.MINDMAP_RUN_ID || '', tool: toolName, input: input || {}, cwd: process.cwd(), at: Date.now() });
    const until = Date.now() + WAIT_MS;
    try {
        while (Date.now() < until) {
            await new Promise(r => setTimeout(r, 300));
            let a;
            try { a = JSON.parse(fs.readFileSync(ans, 'utf8')); } catch { continue; }
            return a.allow ? { behavior: 'allow', updatedInput: input || {} } : { behavior: 'deny', message: a.message || '사용자가 거절했어요' };
        }
        return { behavior: 'deny', message: '10분 동안 답이 없어서 거절했어요' };
    } finally {
        for (const f of [req, ans]) { try { fs.unlinkSync(f); } catch { /* 없음 */ } }
    }
}

const TOOLS = [
    { name: 'approve', description: '도구를 써도 되는지 마인드맵 화면에서 사람에게 묻는다',
      inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name'] } }
];

function send(msg) {
    process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(msg) {
    const { id, method, params } = msg;
    if (method === 'initialize') {
        return send({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mindmap-approve', version: VERSION } } });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
        if (!params || params.name !== 'approve') return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `모르는 도구: ${params && params.name}` } });
        const a = params.arguments || {};
        const r = await ask(a.tool_name, a.input);
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(r) }] } });
    }
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `모르는 요청: ${method}` } });
}

if (require.main === module) {
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', line => {
        if (!line.trim()) return;
        let msg;
        try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 이 아니에요' } }); }
        handle(msg).catch(e => send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } }));
    });
}

module.exports = { ask, DIR };
