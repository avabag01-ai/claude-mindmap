/**
 * MemoStore.js
 * =============================================================================
 * 세션 허브 메모 저장소 (메인 프로세스 전용)
 *
 * - 저장 위치: ~/.flowcode/memos.json (파일 권한 600)
 * - 종류: memo(메모) · code(코드 조각) · secret(비밀: 주소·API 키·비밀번호)
 * - 비밀 메모는 본문을 암호화해서 저장한다. Electron safeStorage(맥은 키체인)를 넘겨받아 쓰고,
 *   이 컴퓨터에서 암호화를 못 하면 평문으로 저장하되 enc:false 로 표시해 화면에 알린다.
 * - 목록(list)은 비밀 메모 본문을 빼고 보낸다. 본문은 reveal 로 하나씩 꺼낸다.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const KINDS = new Set(['memo', 'code', 'secret']);

class MemoStore {
    /**
     * @param {object} [options]
     * @param {string} [options.file]
     * @param {{ isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string }} [options.safeStorage]
     */
    constructor(options = {}) {
        this.file = options.file || path.join(os.homedir(), '.flowcode', 'memos.json');
        this.safeStorage = options.safeStorage || null;
    }

    canEncrypt() {
        try {
            return !!(this.safeStorage && this.safeStorage.isEncryptionAvailable());
        } catch {
            return false;
        }
    }

    _read() {
        try {
            const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            return Array.isArray(d.memos) ? d.memos : [];
        } catch {
            return [];
        }
    }

    _write(memos) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, memos }, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, this.file);
        try { fs.chmodSync(this.file, 0o600); } catch { /* 권한을 못 바꾸는 파일 시스템 */ }
    }

    /** 화면용 목록: 비밀 메모는 본문 없이 */
    list() {
        return {
            canEncrypt: this.canEncrypt(),
            memos: this._read()
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .map(m => m.kind === 'secret'
                    ? { id: m.id, title: m.title, kind: m.kind, updatedAt: m.updatedAt, encrypted: !!m.enc, length: m.length || 0 }
                    : { id: m.id, title: m.title, kind: m.kind, updatedAt: m.updatedAt, body: m.body })
        };
    }

    /** 새 메모 또는 고치기. 비밀 메모를 고칠 때 body 가 null 이면 본문은 그대로 둔다 */
    save({ id, title, kind, body }) {
        if (!KINDS.has(kind)) throw new Error('메모 종류가 올바르지 않아요');
        title = String(title || '').trim();
        if (!title) throw new Error('제목을 써 주세요');
        if (title.length > 200) throw new Error('제목이 너무 길어요');
        if (body != null && String(body).length > 200000) throw new Error('본문이 너무 길어요');

        const memos = this._read();
        const now = Date.now();
        let m = id ? memos.find(x => x.id === id) : null;
        if (id && !m) throw new Error('없는 메모예요');
        if (!m) {
            m = { id: crypto.randomUUID(), createdAt: now };
            memos.push(m);
        }
        const wasSecret = m.kind === 'secret';
        m.title = title;
        m.kind = kind;
        m.updatedAt = now;

        if (kind === 'secret') {
            if (body == null && wasSecret) {
                // 본문 그대로
            } else {
                const text = String(body == null ? (m.body || '') : body);
                delete m.body;
                m.length = text.length;
                if (this.canEncrypt()) {
                    m.enc = true;
                    m.data = this.safeStorage.encryptString(text).toString('base64');
                } else {
                    m.enc = false;
                    m.data = Buffer.from(text, 'utf8').toString('base64');
                }
            }
        } else {
            const text = body == null && wasSecret ? this._secretText(m) : String(body == null ? (m.body || '') : body);
            delete m.enc; delete m.data; delete m.length;
            m.body = text;
        }
        this._write(memos);
        return { id: m.id };
    }

    remove(id) {
        const memos = this._read();
        const next = memos.filter(m => m.id !== id);
        if (next.length === memos.length) throw new Error('없는 메모예요');
        this._write(next);
        return { id };
    }

    /** 비밀 메모 본문 꺼내기 (보기·복사·입력창에 넣기 할 때만) */
    reveal(id) {
        const m = this._read().find(x => x.id === id);
        if (!m) throw new Error('없는 메모예요');
        return { id, body: m.kind === 'secret' ? this._secretText(m) : m.body };
    }

    _secretText(m) {
        if (!m.data) return '';
        const buf = Buffer.from(m.data, 'base64');
        if (m.enc) {
            if (!this.canEncrypt()) throw new Error('이 컴퓨터에서는 이 비밀 메모를 풀 수 없어요');
            return this.safeStorage.decryptString(buf);
        }
        return buf.toString('utf8');
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = MemoStore;
}
