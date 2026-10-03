// MemoStore 테스트: 저장·고치기·지우기, 비밀 메모 암호화와 꺼내기
// 실행: node scripts/test-memo-store.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const MemoStore = require('../src/core/MemoStore.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-'));
const file = path.join(tmp, 'memos.json');
// 가짜 safeStorage: 뒤집고 표시를 붙인다 (진짜 암호화 대신, 평문이 파일에 안 남는지만 본다)
const fake = {
    isEncryptionAvailable: () => true,
    encryptString: s => Buffer.from('ENC:' + [...s].reverse().join(''), 'utf8'),
    decryptString: b => [...b.toString('utf8').slice(4)].reverse().join('')
};

const store = new MemoStore({ file, safeStorage: fake });
const a = store.save({ title: '서버 주소', kind: 'memo', body: 'https://example.local:8080' });
const c = store.save({ title: '반복문', kind: 'code', body: 'for f in *.mid; do echo $f; done' });
const k = store.save({ title: 'API 키', kind: 'secret', body: 'sk-test-1234' });

let l = store.list();
assert.strictEqual(l.canEncrypt, true);
assert.strictEqual(l.memos.length, 3);
const ks = l.memos.find(m => m.id === k.id);
assert.strictEqual(ks.body, undefined, '목록에는 비밀 본문이 없다');
assert.strictEqual(ks.encrypted, true);
assert.strictEqual(ks.length, 12);
assert.strictEqual(l.memos.find(m => m.id === c.id).body, 'for f in *.mid; do echo $f; done');
const raw = fs.readFileSync(file, 'utf8');
assert.ok(!raw.includes('sk-test-1234'), '파일에 비밀이 평문으로 남지 않는다');
assert.strictEqual((fs.statSync(file).mode & 0o777).toString(8), '600', '파일 권한 600');
assert.strictEqual(store.reveal(k.id).body, 'sk-test-1234');

// 비밀 메모 제목만 고치면 본문은 그대로
store.save({ id: k.id, title: 'OpenAI 키', kind: 'secret', body: null });
assert.strictEqual(store.reveal(k.id).body, 'sk-test-1234');
assert.strictEqual(store.list().memos.find(m => m.id === k.id).title, 'OpenAI 키');
// 일반 → 비밀 → 일반
store.save({ id: a.id, title: '서버 주소', kind: 'secret', body: null });
assert.strictEqual(store.reveal(a.id).body, 'https://example.local:8080');
store.save({ id: a.id, title: '서버 주소', kind: 'memo', body: null });
assert.strictEqual(store.list().memos.find(m => m.id === a.id).body, 'https://example.local:8080');

// 잘못된 입력
assert.throws(() => store.save({ title: '', kind: 'memo', body: 'x' }), /제목/);
assert.throws(() => store.save({ title: 'x', kind: 'nope', body: 'x' }), /종류/);
assert.throws(() => store.save({ id: 'nope', title: 'x', kind: 'memo', body: 'x' }), /없는 메모/);

// 지우기
store.remove(c.id);
assert.strictEqual(store.list().memos.length, 2);
assert.throws(() => store.remove(c.id), /없는 메모/);

// 암호화를 못 하는 컴퓨터: 평문(base64)으로 두고 encrypted:false 로 알린다
const plain = new MemoStore({ file: path.join(tmp, 'plain.json') });
const p = plain.save({ title: '비번', kind: 'secret', body: 'pw' });
assert.strictEqual(plain.list().canEncrypt, false);
assert.strictEqual(plain.list().memos[0].encrypted, false);
assert.strictEqual(plain.reveal(p.id).body, 'pw');
// 암호화된 메모를 암호화 못 하는 곳에서 열면 막는다
assert.throws(() => new MemoStore({ file }).reveal(k.id), /풀 수 없어요/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('MemoStore: 모든 테스트 통과');
