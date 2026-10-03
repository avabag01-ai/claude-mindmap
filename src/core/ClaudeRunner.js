/**
 * ClaudeRunner.js
 * =============================================================================
 * 세션 허브 대화창에서 보낸 메시지를 Claude Code CLI 로 실행하는 모듈 (메인 프로세스 전용)
 *
 *   이어서:  claude -p --resume <sessionId> --output-format stream-json --verbose "<메시지>"
 *   새 세션: claude -p --output-format stream-json --verbose "<메시지>"   (cwd = 고른 폴더)
 *
 * - 맥 앱을 Finder 에서 켜면 PATH 가 짧아서 claude 를 못 찾는다. 그래서 로그인 셸의 PATH 를 읽어 와 그걸로 실행한다.
 * - MINDMAP_CLAUDE_BIN 환경 변수로 실행 파일을 바꿀 수 있다 (테스트용 가짜 claude 등).
 * - stdout 의 stream-json 한 줄 = 이벤트 하나. onEvent 로 그대로 넘긴다.
 */

const { spawn } = require('child_process');
const { childEnv } = require('./loginPath.js');
const fs = require('fs');

const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan']);

// 답 길이: 대화창의 결과만 / 요약 / 자세히 버튼. --append-system-prompt 로 붙여서 사람이 쓴 메시지는 그대로 남는다.
const ANSWER_STYLES = {
    result: '이번 답은 결과만 한두 줄로 쓴다. 과정·설명·다음 제안은 빼고, 사용자가 물으면 그때 말한다. 막힌 것이 있으면 그것만 한 줄로.',
    summary: '이번 답은 짧게 요약한다. 5줄 안쪽으로 결과와 꼭 알아야 할 것만, 쉬운 말로.',
    detail: '이번 답은 자세히 쓴다. 무엇을 왜 했는지, 무엇을 확인했는지, 남은 것은 무엇인지 쉬운 말로 충분히 설명한다.'
};

class ClaudeRunner {
    constructor(options = {}) {
        this.bin = options.bin || process.env.MINDMAP_CLAUDE_BIN || 'claude';
        this.runs = new Map(); // runId → child
    }

    /**
     * @param {object} req
     * @param {string} req.runId          화면이 붙인 실행 번호
     * @param {string} req.cwd            실행 폴더 (세션의 cwd)
     * @param {string} req.text           보낼 메시지
     * @param {string} [req.sessionId]    이어갈 세션 (없으면 새 세션)
     * @param {string} [req.permissionMode] default | acceptEdits | plan
     * @param {string} [req.answerMode]   result | summary | detail (없으면 Claude 기본)
     * @param {string} [req.approveScript] scripts/mindmap-approve-mcp.js — 있으면 물을 도구를 막지 않고 화면에 묻는다 (main.js 가 채움)
     * @param {(event: object) => void} onEvent   stream-json 이벤트, 또는 { type: 'stderr', text }
     * @param {(result: { code: number|null, signal: string|null, stopped: boolean }) => void} onExit
     */
    run(req, onEvent, onExit) {
        if (!req.text || !req.text.trim()) throw new Error('보낼 메시지가 비어 있어요');
        if (!req.cwd || !fs.existsSync(req.cwd)) throw new Error(`폴더가 없어요: ${req.cwd}`);

        const args = ['-p', '--output-format', 'stream-json', '--verbose'];
        if (req.sessionId) args.push('--resume', req.sessionId);
        if (req.permissionMode && PERMISSION_MODES.has(req.permissionMode) && req.permissionMode !== 'default') {
            args.push('--permission-mode', req.permissionMode);
        }
        if (req.approveScript && req.permissionMode !== 'plan') args.push(...ClaudeRunner.approveArgs(req.approveScript, req.runId));
        if (ANSWER_STYLES[req.answerMode]) args.push('--append-system-prompt', ANSWER_STYLES[req.answerMode]);
        args.push(req.text);

        // 셸을 거치지 않고 바로 실행 (인자 따옴표 문제 없음), PATH 는 로그인 셸 것
        const child = spawn(this.bin, args, {
            cwd: req.cwd,
            env: childEnv(),
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const run = { child, stopped: false };
        this.runs.set(req.runId, run);

        let buf = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            buf += chunk;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i).trim();
                buf = buf.slice(i + 1);
                if (!line) continue;
                try {
                    onEvent(JSON.parse(line));
                } catch {
                    onEvent({ type: 'stderr', text: line });
                }
            }
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', text => onEvent({ type: 'stderr', text }));
        let exited = false;
        child.on('error', err => {
            onEvent({ type: 'stderr', text: err.code === 'ENOENT' ? `claude 를 찾지 못했어요 (${this.bin}). 터미널에서 which claude 로 위치를 확인하고 MINDMAP_CLAUDE_BIN 으로 알려 주세요.` : `실행 실패: ${err.message}` });
            if (!exited) { exited = true; this.runs.delete(req.runId); onExit({ code: null, signal: null, stopped: false }); }
        });
        child.on('close', (code, signal) => {
            if (exited) return;
            exited = true;
            const rest = buf.trim();
            if (rest) {
                try { onEvent(JSON.parse(rest)); } catch { onEvent({ type: 'stderr', text: rest }); }
            }
            this.runs.delete(req.runId);
            onExit({ code, signal, stopped: run.stopped });
        });
        return run;
    }

    stop(runId) {
        const run = this.runs.get(runId);
        if (!run) return false;
        run.stopped = true;
        run.child.kill('SIGINT');
        setTimeout(() => { if (this.runs.has(runId)) run.child.kill('SIGKILL'); }, 3000);
        return true;
    }

    stopAll() {
        for (const id of [...this.runs.keys()]) this.stop(id);
    }
}

/** 허용 묻기: claude 가 물을 도구를 쓰려 하면 이 MCP 도구가 화면(허용 / 거절)에 묻는다 */
ClaudeRunner.approveArgs = function (script, runId) {
    const cfg = { mcpServers: { 'mindmap-approve': { command: 'node', args: [script], env: { MINDMAP_RUN_ID: runId || '' } } } };
    return ['--mcp-config', JSON.stringify(cfg), '--permission-prompt-tool', 'mcp__mindmap-approve__approve'];
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = ClaudeRunner;
    module.exports.ANSWER_STYLES = ANSWER_STYLES;
}
