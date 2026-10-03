# 클로드 마인드맵 (claude-mindmap)

Claude Code 세션을 한눈에 보고, 지시하고, 이어 가는 맥 앱입니다.
흩어진 세션을 폴더별 마인드맵으로 보고, 대화창에서 바로 이어서 말하고, 파일·메모·GitHub·브라우저까지 한 창에서 다룹니다.

flowcode 의 세션 허브를 떼어 낸 독립 앱입니다. 설정과 메모는 `~/.flowcode/` 를 같이 씁니다.

## 실행

```bash
npm install
npm start        # 개발자 도구까지: npm run dev
npm test         # 테스트 7종
```

- 필요한 것: 맥, Node.js, [Claude Code](https://claude.com/claude-code)(`claude`), git. GitHub 탭은 `gh`(`brew install gh && gh auth login`).
- 처음 한 번 맥이 "제어하려고 합니다"(브라우저 조종), 키체인 접근(비밀 메모·사용량)을 물으면 허용하세요.

## 화면

앱을 켜면 창이 가로 세 칸으로 열립니다.
맥에 남은 Claude Code 세션 기록(`~/.claude/projects/`)을 읽습니다.

```
┌ 세션 목록 ─────┬──── 마인드맵 ─────────────────────┬ 대화창 ──────────┐
│ 최근 / 폴더별   │ 전체 · 폴더 중심 · 세션 중심        │ 고른 세션의 대화   │
│ 검색, 새 세션   │ 가운데에서 사방으로 펼쳐짐          │ 이어서 말하기      │
└───────────────┴───────────────────────────────────┴──────────────────┘
```

- **왼쪽 세션 목록**: Claude 앱처럼 오늘 / 어제 / 이번 주 / 그 전으로 묶거나 폴더별로 봅니다. 세션을 누르면 가운데와 오른쪽이 그 세션으로 바뀝니다.
- **가운데 마인드맵**
  - 전체: `Claude → 폴더 → 세션 → 고친 파일`. 처음에는 **폴더만** 보이고, 폴더 아래 `▸ N`(숨은 세션 수)을 누르면 펼쳐집니다.
    주제 가지도 `▸ N` / `▾` 로 접고 펼칩니다(전체 보기는 접힘, 폴더 중심은 펼침). 도구 막대 **가지 모두 접기 / 펼치기**.
  - 폴더는 기간과 상관없이 늘 보입니다(이 기간에 세션이 없으면 흐리게). 왼쪽 **+ 폴더**로 고른(또는 새로 만든) 폴더는
    세션이 없어도 목록·지도에 나옵니다(`~/.flowcode/folders.json`).
  - 노드끼리 겹치면 서로 밀어내서 가리는 노드가 없게 그립니다.
  - **노드 끌어 옮기기**: 아무 노드나 끌어서 원하는 자리에 둡니다. 그 아래 노드도 같이 따라오고, 보기(전체·폴더 중심·세션 중심)마다
    자리를 기억합니다(localStorage `smm.pins`). 도구 막대 **자리 되돌리기**로 처음 배치로.
  - 폴더 중심: 고른 폴더가 가운데, 둘레에 그 폴더의 세션
  - 세션 중심: 고른 세션이 가운데, 둘레에 고친 파일, 그 바깥에 같은 파일을 고친 다른 세션 (폴더를 넘나듦)
  - 맵의 세션을 누르면 그 세션으로 이동하고, 파일을 누르면 그 파일을 고친 세션과 "코드 보기"가 나옵니다.
- **오른쪽 대화창**: 고른 세션의 대화를 보여주고, 4초마다 새 기록을 확인합니다. 입력창에서 보내면 그 세션을
  `claude -p --resume <id>` 로 이어서 실행하고 답을 실시간으로 보여줍니다. 세션을 고르지 않고 **새 세션**을 누르면 고른 폴더에서 새로 시작합니다.
  - 권한: 기본(권한을 묻는 도구는 막힘) / 파일 수정 자동 허용 / 계획만
  - 앱을 Finder 에서 켜도 `claude` 를 찾도록 로그인 셸로 실행합니다. 다른 실행 파일은 `FLOWCODE_CLAUDE_BIN` 으로 지정합니다.

- **모양**: 가운데 = 이중 원(전체) / 큰 폴더(폴더 중심) / 큰 카드(세션 중심), 폴더 = 폴더 모양, 세션 = 카드(초록 = 작업 중, 점선 = 지난 세션), 파일 = 문서 아이콘. 가지는 가운데로 갈수록 굵어집니다.
- **세션 순서**: 폴더 안 세션은 시작 시각 순서대로 12시 방향부터 시계방향, 이름 앞에 순번, 아래에 기간(`10-03 12:16~14:57`).
- **가운데 원을 누르면 툰 허브**: 폴더의 `.toon/HUB.toon` 전문을 보여주고, 주제 허브 탭으로 바꿔 볼 수 있습니다. 전체 보기에서는 허브가 있는 폴더 목록이 나옵니다.
- **폴더 ⊕**: 그 폴더에 새 세션 자리를 만들고 입력창으로 갑니다. 폴더에 툰 허브가 있으면 "툰 허브 읽고 시작"이 켜져서,
  제목이나 할 일만 써도 `툰 불러와 — 하위 세션, root: <폴더>, topic: <주제>, hub_task: <쓴 글>` 로 시작합니다.
- **세션 끌어다 놓기** (마인드맵에서 세션 카드를 끌기):
  - 같은 폴더의 다른 세션 위 → 그 세션의 **하위 세션**으로 붙습니다 (모서리가 각진 카드, 왼쪽 목록에서는 들여쓰기).
  - 폴더 위 → 폴더 바로 아래로 떼어냅니다. 빈 곳에 놓으면 자리만 옮깁니다.
  - **다른 폴더**(또는 다른 폴더의 세션) 위 → 확인 후 그 폴더로 **복사**합니다. 원본은 그대로 두고, 대화 기록을 새 세션 id 로
    `~/.claude/projects/<그 폴더>/` 에 복사하면서 작업 폴더를 바꿔서, 그 폴더에서 `claude --resume` 으로 이어갈 수 있습니다.
  - 하위 세션 정보는 Claude Code 에 없는 개념이라 `~/.flowcode/session-links.json` 에 따로 저장합니다.
- **툰 → 이어가기**: 고른 세션에 툰 저장을 시키고, 답의 ```` ```toon-next ```` 블록(없으면 "툰 불러…" 줄)을 시작 메시지로
  같은 폴더에 새 세션을 열어 이어갑니다. 툰 저장은 파일을 써야 해서 최소 "파일 수정 자동 허용"으로 실행합니다.

- **사용량 막대** (가운데 칸 오른쪽 위): 지금 세션(5시간) 한도와 주간 한도를 "몇 % 남음" 가로 막대로, 초기화 시각과 함께.
  50% 아래면 주황, 20% 아래면 빨강. 2분마다, 창으로 돌아올 때, 보내기가 끝날 때 다시 읽고, 누르면 바로 새로고침.
  Claude Code 의 `/usage` 와 같은 곳(`api.anthropic.com/api/oauth/usage`)을 맥 키체인의 Claude Code 로그인으로 읽습니다.
  공개 문서가 있는 API 가 아니라서 바뀌면 "알 수 없음"으로 나옵니다.
- **왼쪽 탭**: 세션 · 파인더 · 메모
  - **파인더**: 폴더를 둘러보고(↑, 홈, 세션 폴더, 숨김 파일), 파일을 대화창이나 세션(목록·맵)으로 끌어다 놓으면 첨부됩니다.
    두 번 누르면 바로 첨부. 맥 Finder 에서 끌어와도 됩니다. 보낼 때 `첨부 파일:` 아래에 경로가 붙어서 Claude 가 읽습니다.
  - **메모**: 메모 · 코드 · 비밀 세 종류. 복사, 입력창에 넣기, 고치기, 지우기. 비밀 메모(API 키, 비밀번호)는
    맥 키체인(Electron safeStorage)으로 암호화해 `~/.flowcode/memos.json`(권한 600)에 저장하고 목록에서는 가려 보여 줍니다.
    입력창에 넣을 때는 대화 기록에 남는다고 한 번 묻습니다.
  - **GitHub**: 고른 세션의 저장소. 브랜치·앞섬/뒤짐, 바뀐 파일(누르면 diff, 첨부 가능), 모두 커밋, 가져오기(`pull --ff-only`),
    푸시(확인 후), draft PR 만들기(확인 후), 열린 PR·이슈·이 커밋의 체크(`gh api` REST), 최근 커밋.
    **Claude 에게 맡기기** 버튼(커밋·푸시, PR, 리뷰 코멘트, CI 고치기, main 따라잡기)은 할 일을 입력창에 넣어 줍니다.
    `gh` 가 없거나 로그인 전이면 `brew install gh && gh auth login` 을 안내합니다. force push·reset·브랜치 삭제는 없습니다.
  - **브라우저**: 앱 안 브라우저가 아니라 맥의 **진짜 크롬·사파리·Brave·Edge** 를 애플스크립트로 조종합니다(로그인 그대로).
    주소창(주소면 열고 아니면 구글·네이버 검색), 열린 탭 목록·옮기기, 뒤로·앞으로·새로고침, 앞 탭 **읽기**.
    읽은 페이지는 **세션에서 읽고 툰 요약**(전문을 한 번 보내고 세션이 툰으로 요약해 기억), 대화창에 넣기, 주소만 넣기.
    다른 탭의 링크(GitHub PR 등)도 여기서 고른 브라우저로 엽니다.
  - **Claude 에 연결**: `scripts/flowcode-browser-mcp.js` 를 Claude Code 에 MCP 서버로 등록합니다(`claude mcp add --scope user`).
    그러면 모든 세션이 `browser_tabs · browser_open · browser_search · browser_switch · browser_read · browser_click · browser_type ·
    browser_navigate · browser_eval` 로 같은 브라우저를 조종합니다. 쓸 브라우저는 `~/.flowcode/browser.json`(브라우저 탭에서 고른 것).
  - 처음 한 번: 크롬 계열은 보기 > 개발자 정보 > "Apple Events의 자바스크립트 허용", 사파리는 개발자용 메뉴의 같은 항목,
    그리고 맥이 "제어하려고 합니다"를 물으면 허용.

| 파일 | 역할 |
|---|---|
| `index.html` | 창 (세 칸) |
| `main.js` | IPC: 세션·대화·툰 허브·파인더·메모·git·사용량·브라우저 |
| `src/modules/SessionHub.js` | 세션 목록, 대화창, 세 칸 연결, 첨부 |
| `src/modules/HubPanels.js` | 파인더 탭, 메모 탭 |
| `src/core/MemoStore.js` | 메모 저장 (비밀 메모 암호화) |
| `src/core/GitPanel.js` | GitHub 탭의 git / gh 실행 |
| `src/core/BrowserBridge.js` | 맥 브라우저 조종 (애플스크립트) |
| `scripts/flowcode-browser-mcp.js` | Claude 가 브라우저를 조종하는 MCP 서버 (의존성 없음) |
| `src/core/UsageMeter.js` | 세션·주간 사용량 읽기 |
| `src/core/loginPath.js` | 로그인 셸 PATH 를 한 번 읽어 claude·gh 를 찾게 함 |
| `src/modules/SessionMindMap.js` | 방사형 마인드맵 (전체 / 폴더 중심 / 세션 중심) |
| `src/core/SessionIndexer.js` | 세션 기록 → 폴더 → 세션 → 파일, 대화 읽기 (메인 프로세스) |
| `src/core/ClaudeRunner.js` | 대화창 메시지를 `claude -p` 로 실행하고 stream-json 을 넘김 (메인 프로세스) |
| `scripts/test-session-indexer.js`, `scripts/test-claude-runner.js` | 테스트: `node scripts/test-session-indexer.js && node scripts/test-claude-runner.js && node scripts/test-session-hub.js && node scripts/test-memo-store.js && node scripts/test-git-panel.js && node scripts/test-usage-meter.js && node scripts/test-browser.js` |
| `scripts/fake-claude.js`, `scripts/fake-osascript.js` | 테스트용 가짜 claude, 가짜 osascript |

## 툰

작업 기록은 `.toon/` 에 있습니다. 새 세션은 `툰 불러와 — root: ~/claude-mindmap, topic: claude-mindmap` 으로 이어 가세요.
