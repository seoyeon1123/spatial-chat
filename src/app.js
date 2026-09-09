// 렌더러: UI + Firebase 실시간 동기화
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase, ref, onValue, update, remove, set,
  onDisconnect, push, get, serverTimestamp,
  query, limitToLast
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

const MAX_MEMBERS = 5;
const BUBBLE_MS = 4000;          // 말풍선 유지 시간
const LOG_LIMIT = 100;           // 대화 기록에서 불러올 최근 메시지 수
const KEEP_MAX = 200;            // DB에 남겨둘 최대 메시지 수 (입장 시 초과분 삭제)
const MAX_AGE_MS = 24 * 60 * 60 * 1000;   // 24시간 지난 메시지는 입장 시 삭제
const CLEANUP_TIMEOUT_MS = 1500;          // 정리가 느려도 종료가 막히지 않도록
const CHARS = ["🐱","🐶","🦊","🐰","🐻","🐼","🐸","🦁","🐧","🐯","🐵","🐹"];

// ---------- Firebase ----------
let db = null, auth = null, authReady = null;
try {
  const fbApp = initializeApp(firebaseConfig);
  db = getDatabase(fbApp);
  auth = getAuth(fbApp);
  // 익명 로그인. 사용자는 로그인한 줄 모르지만, 보안 규칙이 "본인 노드만 쓰기"를
  // 강제할 수 있게 되고 로그인하지 않은 접근은 전부 거부된다.
  // 세션이 브라우저 저장소에 남아 다시 켜도 같은 uid를 받는다.
  authReady = signInAnonymously(auth).then((c) => c.user.uid);
} catch (e) {
  console.error("Firebase 초기화 실패:", e);
  authReady = Promise.reject(e);
}
function ensureAuth() { return authReady; }

// ---------- 상태 ----------
let myChar = null, myNick = "", roomCode = "", myId = null;
let membersRef = null, myRef = null, msgsRef = null;
let iAmFirst = false;                // 입장 시 방이 비어 있었는지
// 정규화 좌표(0~1). 모두 같은 자리에 겹치지 않도록 조금씩 흩어서 시작한다.
let myPos = { x: 0.3 + Math.random() * 0.4, y: 0.58 + Math.random() * 0.22 };
const actorEls = {};                 // memberId -> {el, lastMsgAt}
let dragging = false;

// ---------- DOM ----------
const $ = (s) => document.querySelector(s);
const lobby = $("#lobby"), overlay = $("#overlay"), stage = $("#stage");
const inputBox = $("#inputBox"), chatInput = $("#chatInput");
const chatlog = $("#chatlog"), logBody = $("#logBody"), logEmpty = $("#logEmpty"), logBadge = $("#logBadge");
let current = null;                  // 현재 입력 대상 actor

// ====== 클릭 통과 토글 (오버레이 핵심) ======
// main.js가 setIgnoreMouseEvents(false)로 창을 띄우므로 여기서도 false로 맞춘다.
// (true로 두면 첫 setIgnore(true)가 "이미 같은 값"으로 판단돼 IPC를 안 보내고,
//  메인은 계속 클릭을 먹어서 바탕화면 전체가 안 눌린다)
let ignoring = false;
function setIgnore(v) {
  if (v === ignoring) return;
  ignoring = v;
  if (window.overlay) window.overlay.setIgnoreMouse(v);
}
document.addEventListener("mousemove", (e) => {
  if (dragging) { setIgnore(false); return; }
  const hit = e.target.closest(".interactive, .actor, #inputBox, #lobby");
  setIgnore(!hit);
});

// ====== 로비 ======
// 1단계에서 "방 만들기 / 참여하기"를 먼저 고르고, 2단계에서 캐릭터·닉네임을 정한다.
// 참여할 땐 코드를 먼저 확인해야 그 방에서 이미 쓰는 캐릭터를 막을 수 있다.
const step1 = $("#step1"), step2 = $("#step2"), step2Title = $("#step2Title");
const charGrid = $("#charGrid"), pickSub = $("#pickSub");
const nickEl = $("#nick"), enterBtn = $("#enter"), lobbyErr = $("#lobbyErr");
const roomRow = $("#roomRow"), roomCodeEl = $("#roomCode"), roomStat = $("#roomStat");
const newCodeBox = $("#newCodeBox"), newCodeEl = $("#newCode");

let mode = "create";          // create | join
let issuedCode = "";          // 만들기에서 발급받은 코드
let roomOk = false;           // 참여하기에서 확인된 유효한 방인지
let takenChars = new Set();   // 그 방에서 이미 쓰는 캐릭터
let unwatchRoom = null;       // 로비에서 방을 지켜보는 구독 해제 함수

// --- 캐릭터 그리드 ---
const charEls = new Map();
CHARS.forEach((c) => {
  const d = document.createElement("div");
  d.className = "char-pick"; d.textContent = c;
  d.onclick = () => {
    if (d.classList.contains("taken")) return;      // 남이 쓰는 캐릭터
    myChar = c; paintChars(); checkReady();
  };
  charGrid.appendChild(d);
  charEls.set(c, d);
});

function paintChars() {
  charEls.forEach((el, c) => {
    const taken = takenChars.has(c);
    el.classList.toggle("taken", taken);
    el.classList.toggle("sel", !taken && myChar === c);
    el.title = taken ? "이미 사용 중이에요" : "";
  });
}

// 남이 내 캐릭터를 먼저 가져갔으면 선택 해제
function dropTakenSelection() {
  if (myChar && takenChars.has(myChar)) {
    myChar = null;
    lobbyErr.textContent = "고른 캐릭터를 다른 분이 먼저 선택했어요";
  }
}

// --- 단계 전환 ---
function showStep(n) {
  step1.classList.toggle("hidden", n !== 1);
  step2.classList.toggle("hidden", n !== 2);
}

function resetLobby() {
  stopWatchingRoom();
  myChar = null; issuedCode = ""; roomOk = false;
  takenChars = new Set();
  roomCodeEl.value = ""; roomStat.textContent = ""; roomStat.className = "roomStat";
  lobbyErr.textContent = "";
  paintChars(); checkReady();
}

$("#goCreate").onclick = async () => {
  mode = "create"; resetLobby();
  step2Title.textContent = "방 만들기";
  newCodeBox.classList.remove("hidden");
  roomRow.classList.add("hidden");
  pickSub.textContent = "캐릭터와 닉네임을 고르세요";
  enterBtn.textContent = "만들고 입장하기";
  showStep(2);
  nickEl.focus();

  // 안 쓰는 코드를 미리 발급해 보여준다 (친구에게 먼저 알려줄 수 있게)
  newCodeEl.textContent = "발급 중…";
  try {
    issuedCode = await withTimeout(freshRoomCode(), "코드 발급 실패");
    newCodeEl.textContent = issuedCode;
  } catch (e) {
    console.error(e);
    newCodeEl.textContent = "······";
    lobbyErr.textContent = "Firebase 연결 실패 — 설정을 확인해 주세요";
  }
  checkReady();
};

$("#goJoin").onclick = () => {
  mode = "join"; resetLobby();
  step2Title.textContent = "참여하기";
  newCodeBox.classList.add("hidden");
  roomRow.classList.remove("hidden");
  pickSub.textContent = "코드를 먼저 입력하세요";
  enterBtn.textContent = "입장하기";
  showStep(2);
  roomCodeEl.focus();
};

$("#back").onclick = () => { resetLobby(); showStep(1); };

$("#copyNewCode").onclick = () => {
  if (!issuedCode) return;
  navigator.clipboard?.writeText(issuedCode);
  const b = $("#copyNewCode"); b.textContent = "복사됨!";
  setTimeout(() => (b.textContent = "복사"), 1200);
};

// --- 참여하기: 코드가 6자가 되면 그 방을 실시간으로 지켜본다 ---
function stopWatchingRoom() {
  if (unwatchRoom) { unwatchRoom(); unwatchRoom = null; }
}

async function watchRoom(code) {
  stopWatchingRoom();
  if (!db) return;
  try { await ensureAuth(); } catch (e) { console.error("로그인 실패:", e); }
  if (roomCodeEl.value !== code) return;      // 대기 중에 코드가 바뀌었으면 버린다
  const r = ref(db, `rooms/${code}/members`);
  unwatchRoom = onValue(r, (snap) => {
    const members = snap.val() || {};
    const list = Object.values(members);
    roomOk = list.length > 0;
    takenChars = new Set(list.map((m) => m.char));

    if (!roomOk) {
      roomStat.textContent = "그런 공간이 없어요. 코드를 다시 확인해 주세요";
      roomStat.className = "roomStat bad";
      pickSub.textContent = "코드를 먼저 입력하세요";
    } else if (list.length >= MAX_MEMBERS) {
      roomStat.textContent = `정원이 가득 찼어요 (${list.length}/${MAX_MEMBERS}명)`;
      roomStat.className = "roomStat bad";
    } else {
      roomStat.textContent = `${list.length}/${MAX_MEMBERS}명 참여 중`;
      roomStat.className = "roomStat ok";
      pickSub.textContent = "캐릭터와 닉네임을 고르세요";
    }

    dropTakenSelection();
    paintChars();
    checkReady();
  }, (err) => {
    console.error("방 확인 실패:", err);
    roomStat.textContent = "방을 확인할 수 없어요";
    roomStat.className = "roomStat bad";
  });
}

roomCodeEl.oninput = () => {
  roomCodeEl.value = roomCodeEl.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  lobbyErr.textContent = "";
  if (roomCodeEl.value.length === 6) {
    roomStat.textContent = "확인 중…"; roomStat.className = "roomStat";
    watchRoom(roomCodeEl.value);
  } else {
    stopWatchingRoom();
    roomOk = false; takenChars = new Set();
    roomStat.textContent = ""; roomStat.className = "roomStat";
    pickSub.textContent = "코드를 먼저 입력하세요";
    paintChars(); checkReady();
  }
};

nickEl.oninput = checkReady;

function checkReady() {
  const base = !!(myChar && nickEl.value.trim());
  const roomReady = mode === "create"
    ? !!issuedCode
    : roomOk && takenChars.size < MAX_MEMBERS;
  enterBtn.disabled = !(base && roomReady);
}

enterBtn.onclick = join;

// 로비에서도 Enter로 진행
[nickEl, roomCodeEl].forEach((el) => {
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing && !enterBtn.disabled) join();
  });
});

// 로비 닫기(앱 종료)
const lobbyCloseBtn = document.querySelector("#lobbyClose");
if (lobbyCloseBtn) lobbyCloseBtn.onclick = () => window.overlay?.quit();

// ====== 토스트 ======
const toastEl = $("#toast");
let toastTimer = null;
function toast(text, ms = 1800) {
  if (!toastEl) return;
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
}

// Esc: 입력창이 열려 있으면 닫는다.
// 그 외에는 실수로 앱이 꺼지지 않도록 2초 안에 한 번 더 눌러야 종료.
const QUIT_CONFIRM_MS = 2000;
let quitArmedUntil = 0;
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (inputBox.style.display === "block") { hideInput(); return; }
  if (logOpen) { toggleLog(false); return; }

  if (Date.now() < quitArmedUntil) { quitApp(); return; }
  quitArmedUntil = Date.now() + QUIT_CONFIRM_MS;
  toast("한 번 더 Esc를 누르면 종료됩니다", QUIT_CONFIRM_MS);
});

// Enter: 오버레이에 포커스가 있으면 내 캐릭터 위에 입력창을 연다.
// (입력창/로비 인풋 안에서 누른 Enter는 각자 핸들러가 처리하므로 여기선 무시)
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing) return;
  if (!overlay || overlay.classList.contains("hidden")) return;   // 아직 로비
  if (inputBox.style.display === "block") return;                 // 이미 열려 있음
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
  e.preventDefault();
  focusChat();
});

// 내 캐릭터 위 입력창 열기 (Enter / 전역 단축키 공용)
function focusChat() {
  const me = actorEls[myId];
  if (!me) return;
  setIgnore(false);          // 입력 중엔 클릭 통과 해제
  openInput(me, myId);
}

// 다른 앱에 포커스가 있을 때: ⌘/Ctrl+Shift+Enter → 창을 띄우고 바로 입력
window.overlay?.onFocusChat(() => {
  if (!overlay || overlay.classList.contains("hidden")) return;
  if (inputBox.style.display === "block") { chatInput.focus(); return; }
  focusChat();
});

async function join() {
  if (!db) { lobbyErr.textContent = "Firebase 초기화 실패 — firebase-config.js 확인"; return; }
  // 설정값이 아직 플레이스홀더면 바로 안내
  if (!firebaseConfig.databaseURL || firebaseConfig.databaseURL.includes("YOUR_PROJECT")) {
    lobbyErr.textContent = "firebase-config.js 에 본인 설정(databaseURL 포함)을 넣어주세요";
    return;
  }

  myNick = nickEl.value.trim();
  roomCode = mode === "create" ? issuedCode : roomCodeEl.value.trim().toUpperCase();
  if (!roomCode) { lobbyErr.textContent = "코드가 준비되지 않았어요"; return; }

  enterBtn.disabled = true; lobbyErr.textContent = "연결 중…";
  stopWatchingRoom();       // 로비 구독 해제 — 입장하면 오버레이가 다시 구독한다

  // 멤버 id로 익명 계정의 uid를 그대로 쓴다.
  // 보안 규칙이 rooms/$room/members/$member 에서 $member === auth.uid 를 요구하므로,
  // 남의 캐릭터를 옮기거나 남의 이름으로 말하는 것이 서버에서 차단된다.
  try {
    myId = await withTimeout(ensureAuth(), "로그인 실패");
  } catch (e) {
    console.error(e);
    lobbyErr.textContent = "Firebase 로그인 실패 — 콘솔에서 익명 인증을 켜주세요";
    enterBtn.disabled = false; return;
  }

  membersRef = ref(db, `rooms/${roomCode}/members`);
  myRef = ref(db, `rooms/${roomCode}/members/${myId}`);

  const newMember = { char: myChar, name: myNick, x: myPos.x, y: myPos.y, msg: "", msgAt: 0 };

  // 규칙이 남의 노드 쓰기를 막으므로 컬렉션 전체를 쓰는 트랜잭션은 더 쓸 수 없다.
  // 대신 확인 → 내 노드만 쓰기 → 사후 확인 순으로 처리하고, 동시 입장이 겹치면
  // uid 사전순으로 뒤인 쪽이 물러난다(양쪽이 같은 판정을 내리므로 한 명만 남는다).
  function bail(msg, resetChar) {
    lobbyErr.textContent = msg;
    if (resetChar) { myChar = null; paintChars(); }
    if (mode === "join") watchRoom(roomCode);
    enterBtn.disabled = false;
  }

  try {
    const before = (await withTimeout(get(membersRef), "방 확인 실패")).val() || {};
    const others = Object.keys(before).filter((k) => k !== myId);
    if (mode === "join" && others.length === 0) return bail("그 사이에 공간이 사라졌어요");
    if (others.length >= MAX_MEMBERS) return bail(`정원이 가득 찼어요 (최대 ${MAX_MEMBERS}명)`);
    if (others.some((k) => before[k].char === myChar)) {
      return bail("그 캐릭터를 방금 다른 분이 선택했어요. 다시 골라주세요", true);
    }
    iAmFirst = others.length === 0;

    await withTimeout(set(myRef, newMember), "입장 실패");

    // 사후 확인 — 같은 순간에 들어온 사람과 겹쳤는지
    const after = (await withTimeout(get(membersRef), "확인 실패")).val() || {};
    const keys = Object.keys(after).sort();
    const dupe = keys.some((k) => k !== myId && after[k].char === myChar && k < myId);
    const over = keys.length > MAX_MEMBERS && keys.indexOf(myId) >= MAX_MEMBERS;
    if (dupe || over) {
      await remove(myRef);
      return bail(dupe ? "그 캐릭터를 방금 다른 분이 선택했어요. 다시 골라주세요"
                       : `정원이 가득 찼어요 (최대 ${MAX_MEMBERS}명)`, dupe);
    }
  } catch (e) {
    console.error("join 실패:", e);
    lobbyErr.textContent =
      e.message === "timeout"
        ? "Firebase 연결 실패 — databaseURL/Database 활성화/보안규칙 확인"
        : "오류: " + (e.message || e);
    enterBtn.disabled = false; return;
  }

  if (mode === "create") toast(`초대코드 ${roomCode} — 상단에서 복사할 수 있어요`, 4000);

  msgsRef = ref(db, `rooms/${roomCode}/messages`);
  onDisconnect(myRef).remove();

  // 방 청소: 첫 사람이면 이전 세션 잔재를 비우고(강제 종료·크래시 대비),
  // 아니면 오래되거나 넘치는 것만 솎아낸다. 실패해도 입장은 막지 않는다.
  (iAmFirst ? remove(msgsRef) : pruneMessages()).catch((e) => console.warn("메시지 정리 실패:", e));

  startOverlay();
}

// ====== 오버레이 시작 ======
function startOverlay() {
  lobby.classList.add("hidden");
  overlay.classList.remove("hidden");
  $("#roomLabel").textContent = `공간 · ${roomCode}`;

  // 멤버 실시간 구독
  onValue(membersRef, (snap) => renderMembers(snap.val() || {}));

  // 버튼들
  $("#copyInvite").onclick = () => {
    navigator.clipboard?.writeText(roomCode);
    const b = $("#copyInvite"); const t = b.textContent;
    b.textContent = "복사됨!"; setTimeout(() => (b.textContent = t), 1200);
  };
  $("#quitBtn").onclick = () => quitApp();

  // 대화 기록 패널
  $("#logBtn").onclick = () => toggleLog();
  $("#logClose").onclick = () => toggleLog(false);
  $("#logTitle").textContent = `대화 내용 · ${roomCode}`;

  // 최근 LOG_LIMIT개만 구독 (방이 오래돼도 부담 없게)
  onValue(query(msgsRef, limitToLast(LOG_LIMIT)), (snap) => {
    const list = [];
    snap.forEach((c) => { list.push({ id: c.key, ...c.val() }); });
    renderLog(list);
  });

  // 빈 곳 클릭 시 입력창 닫기 (stage 배경)
  stage.addEventListener("pointerdown", (e) => {
    if (e.target === stage) { hideInput(); }
  });

  // 말풍선 만료 체크 루프
  setInterval(tickBubbles, 500);
}

// ====== 멤버 렌더 (reconcile) ======
function renderMembers(members) {
  // 떠난 멤버 제거
  Object.keys(actorEls).forEach((id) => {
    if (!members[id]) { actorEls[id].el.remove(); delete actorEls[id]; }
  });

  // 멤버 수 뱃지
  const avs = $("#avs"); avs.innerHTML = "";
  Object.values(members).forEach((m) => {
    const s = document.createElement("span"); s.className = "av"; s.textContent = m.char; avs.appendChild(s);
  });

  // 각 멤버 생성/갱신
  Object.entries(members).forEach(([id, m]) => {
    let a = actorEls[id];
    if (!a) {
      const el = document.createElement("div");
      el.className = "actor" + (id === myId ? " me" : "");
      const bodyEl = document.createElement("div");
      bodyEl.className = "body"; bodyEl.textContent = m.char;
      const nameEl = document.createElement("div");
      nameEl.className = "name"; nameEl.textContent = m.name;   // textContent → HTML 주입 차단
      el.append(bodyEl, nameEl);
      stage.appendChild(el);
      a = actorEls[id] = { el, lastMsgAt: 0 };
      if (id === myId) makeDraggable(a);
      // 말은 항상 내 캐릭터에서 나가므로, 누굴 클릭하든 입력창은 내 위에 연다.
      // (상대 위에 열면 귓속말처럼 보이지만 실제로는 내 말풍선으로 나가서 헷갈린다)
      else el.querySelector(".body").onclick = (e) => { e.stopPropagation(); focusChat(); };
    }
    // 위치: 내 캐릭터는 로컬이 우선(드래그 중 흔들림 방지)
    if (id !== myId || !dragging) {
      const x = (id === myId ? myPos.x : m.x);
      const y = (id === myId ? myPos.y : m.y);
      a.pos = { x, y };                       // 창 크기 변경 때 다시 쓸 비율 좌표
      placeActor(a);
    }
    // 말풍선: 새 메시지면 표시
    if (m.msg && m.msgAt && m.msgAt > a.lastMsgAt && Date.now() - m.msgAt < BUBBLE_MS + 1000) {
      a.lastMsgAt = m.msgAt;
      showBubble(a, m.msg);
    }
  });
}

// ====== 드래그 (내 캐릭터) ======
function makeDraggable(a) {
  let down = false, moved = false, sx, sy, ox, oy, lastSync = 0;
  a.el.addEventListener("pointerdown", (e) => {
    down = true; moved = false; sx = e.clientX; sy = e.clientY;
    ox = parseFloat(a.el.style.left); oy = parseFloat(a.el.style.top);
    a.el.setPointerCapture(e.pointerId);
  });
  a.el.addEventListener("pointermove", (e) => {
    if (!down) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!moved && Math.hypot(dx, dy) > 5) { moved = true; dragging = true; a.el.classList.add("dragging"); hideInput(); }
    if (moved) {
      const nx = ox + dx, ny = oy + dy;
      a.el.style.left = nx + "px"; a.el.style.top = ny + "px";
      myPos = { x: nx / window.innerWidth, y: ny / window.innerHeight };
      const now = Date.now();
      if (now - lastSync > 80) { lastSync = now; syncPos(); }   // throttle
    }
  });
  a.el.addEventListener("pointerup", (e) => {
    if (!down) return; down = false;
    a.el.classList.remove("dragging");
    if (moved) { dragging = false; syncPos(); }
    else { e.stopPropagation(); openInput(a, myId); }           // 안 움직였으면 클릭=입력
  });
}
function syncPos() { if (myRef) update(myRef, { x: myPos.x, y: myPos.y }); }

// ====== 입력 & 메시지 ======
// 캐릭터를 비율 좌표대로 화면에 배치
function placeActor(a) {
  if (!a.pos) return;
  a.el.style.left = a.pos.x * window.innerWidth + "px";
  a.el.style.top = a.pos.y * window.innerHeight + "px";
}

// 입력창을 캐릭터 위에 붙이되 화면 밖으로 나가지 않게 가둔다.
// (#inputBox는 transform:translate(-50%,0) 이라 left가 곧 가로 중심)
const EDGE = 8;
function positionInput(a) {
  const r = a.el.getBoundingClientRect();
  const w = inputBox.offsetWidth || 240;
  const h = inputBox.offsetHeight || 44;

  const half = w / 2;
  let cx = r.left + r.width / 2;
  cx = Math.min(Math.max(cx, half + EDGE), window.innerWidth - half - EDGE);

  let top = r.top - h - 8;                                  // 기본은 머리 위
  if (top < EDGE) top = r.bottom + 8;                       // 위가 좁으면 발 밑으로
  top = Math.min(top, window.innerHeight - h - EDGE);

  inputBox.style.left = cx + "px";
  inputBox.style.top = top + "px";
}

function openInput(a, id) {
  current = { a, id };
  inputBox.style.display = "block";   // 크기를 재려면 먼저 보이게 해야 한다
  positionInput(a);
  chatInput.value = ""; chatInput.focus();
}
function hideInput() { inputBox.style.display = "none"; current = null; }

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") return hideInput();
  // 한글 조합 중 Enter는 마지막 글자를 확정하는 키다. 여기서 걸러내지 않으면
  // "안녕"의 '녕'이 조합되는 중에 전송돼서 글자가 잘리거나 두 번 눌러야 한다.
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter" && chatInput.value.trim() && current) {
    sendMessage(chatInput.value.trim());
    hideInput();
  }
});

let bubbleToken = 0;
function sendMessage(text) {
  if (!myRef) return;
  // 내 노드에 메시지 기록 → 모두에게 동기화 (말풍선용, 최신 1건만 유지)
  update(myRef, { msg: text, msgAt: serverTimestamp() });
  // 대화 기록에 누적 (말풍선이 사라져도 남는다). uid로 내 메시지를 정확히 식별한다.
  if (msgsRef) push(msgsRef, { uid: myId, char: myChar, name: myNick, text, at: serverTimestamp() });

  // 일정 시간 뒤 말풍선 비우기.
  // 토큰으로 최신 전송만 살려둔다 — 안 그러면 먼저 건 타이머가 나중 말풍선을 조기에 지운다.
  const token = ++bubbleToken;
  setTimeout(() => {
    if (myRef && token === bubbleToken) update(myRef, { msg: "", msgAt: 0 });
  }, BUBBLE_MS);
}

// ====== 방 정리 ======
// 입장할 때 한 번: 24시간이 지났거나 KEEP_MAX를 넘긴 오래된 메시지를 지운다.
// push 키는 시간순이라 snapshot 순회 순서가 곧 오래된 순이다.
async function pruneMessages() {
  if (!msgsRef) return;
  const snap = await get(msgsRef);
  if (!snap.exists()) return;

  const keys = [];
  snap.forEach((c) => { keys.push([c.key, c.val()]); });

  const cutoff = Date.now() - MAX_AGE_MS;
  const overflow = Math.max(0, keys.length - KEEP_MAX);
  const updates = {};
  keys.forEach(([k, v], i) => {
    const tooOld = typeof v?.at === "number" && v.at < cutoff;
    if (tooOld || i < overflow) updates[k] = null;
  });

  const n = Object.keys(updates).length;
  if (n) { await update(msgsRef, updates); console.log(`오래된 메시지 ${n}건 정리`); }
}

// 나갈 때: 내 멤버를 지우고, 내가 마지막이었으면 방(기록 포함)을 통째로 지운다.
async function leaveRoom() {
  if (!myRef || !db) return;
  await remove(myRef);
  const snap = await get(membersRef);
  const left = snap.exists() ? Object.keys(snap.val() || {}).length : 0;
  if (left === 0) {
    // rooms/$room 노드 자체엔 쓰기 권한이 없으므로 messages를 지운다.
    // members는 이미 비었고, RTDB는 자식이 없는 노드를 자동으로 없애므로 방이 통째로 사라진다.
    await remove(msgsRef);
    console.log("마지막 사용자 — 방 삭제:", roomCode);
  }
}

// 정리를 시도하되, 네트워크가 느려도 종료가 붙잡히지 않게 타임아웃을 건다.
async function quitApp() {
  try {
    await Promise.race([
      leaveRoom(),
      new Promise((r) => setTimeout(r, CLEANUP_TIMEOUT_MS)),
    ]);
  } catch (e) {
    console.warn("나가기 정리 실패:", e);
  }
  window.overlay?.quit();
}

// ====== 대화 기록 패널 ======
let logOpen = false, unread = 0;
const seenMsgIds = new Set();
let logLoaded = false;                 // 첫 스냅샷은 "안 읽음"으로 세지 않는다

function toggleLog(force) {
  logOpen = (force === undefined) ? !logOpen : force;
  chatlog.classList.toggle("hidden", !logOpen);
  if (logOpen) { unread = 0; paintBadge(); scrollLogToBottom(); }
}
function paintBadge() {
  logBadge.textContent = unread > 99 ? "99+" : String(unread);
  logBadge.classList.toggle("hidden", unread === 0);
}
function scrollLogToBottom() { logBody.scrollTop = logBody.scrollHeight; }

function renderLog(list) {
  // 새 메시지 개수 세기 (패널이 닫혀 있을 때만 뱃지 증가)
  let fresh = 0;
  list.forEach((m) => { if (!seenMsgIds.has(m.id)) { seenMsgIds.add(m.id); fresh++; } });
  if (logLoaded && !logOpen) { unread += fresh; paintBadge(); }
  logLoaded = true;

  const stick = logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight < 40;

  logBody.textContent = "";
  logEmpty.classList.toggle("hidden", list.length > 0);

  let lastDay = "", lastKey = "";
  list.forEach((m) => {
    // uid 우선(정확), 없으면 예전 메시지라 닉+캐릭터로 추정
    const mine = m.uid ? m.uid === myId : (m.name === myNick && m.char === myChar);
    const at = typeof m.at === "number" ? m.at : Date.now();

    // 날짜 구분선
    const day = new Date(at).toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });
    if (day !== lastDay) {
      const d = document.createElement("div");
      d.className = "log-day"; d.textContent = day;
      logBody.appendChild(d); lastDay = day; lastKey = "";
    }

    // 같은 사람이 연속으로 말하면 아바타/이름 생략 (카톡처럼)
    const key = m.name + "|" + m.char;
    const grouped = key === lastKey;
    lastKey = key;

    const row = document.createElement("div");
    row.className = "log-row" + (mine ? " mine" : "");

    const av = document.createElement("div");
    av.className = "av";
    av.textContent = grouped ? "" : m.char;
    if (grouped) av.style.background = "transparent";
    row.appendChild(av);

    const col = document.createElement("div");
    col.className = "log-col";
    if (!grouped && !mine) {
      const nm = document.createElement("div");
      nm.className = "log-name"; nm.textContent = m.name;
      col.appendChild(nm);
    }

    const line = document.createElement("div");
    line.className = "log-line";
    const tx = document.createElement("div");
    tx.className = "log-text"; tx.textContent = m.text;      // textContent → HTML 주입 차단
    const tm = document.createElement("div");
    tm.className = "log-time";
    tm.textContent = new Date(at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
    line.appendChild(tx); line.appendChild(tm);
    col.appendChild(line);
    row.appendChild(col);
    logBody.appendChild(row);
  });

  if (stick || logOpen) scrollLogToBottom();
}

// ====== 말풍선 ======
function showBubble(a, text) {
  const old = a.el.querySelector(".bubble");
  if (old) old.remove();
  const b = document.createElement("div");
  b.className = "bubble";
  b.textContent = text;
  // 화면 오른쪽 끝이면 왼쪽으로 뒤집기
  const r = a.el.getBoundingClientRect();
  if (r.right + 250 > window.innerWidth) b.classList.add("left");
  a.el.appendChild(b);
  a._bubbleUntil = Date.now() + BUBBLE_MS;
}
function tickBubbles() {
  Object.values(actorEls).forEach((a) => {
    const b = a.el.querySelector(".bubble");
    if (b && a._bubbleUntil && Date.now() > a._bubbleUntil) {
      b.style.transition = ".4s"; b.style.opacity = 0;
      setTimeout(() => b.remove(), 400);
      a._bubbleUntil = 0;
    }
  });
}

// ====== 유틸 ======
// 느린 네트워크에서 로비가 무한정 "연결 중…"으로 남지 않게
function withTimeout(p, label, ms = 10000) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label)), ms)),
  ]);
}

// 살아 있는 방인가? (멤버가 한 명이라도 있어야 방이다 — 마지막 사람이 나가면 소멸)
async function roomExists(code) {
  await ensureAuth();
  const snap = await get(ref(db, `rooms/${code}/members`));
  return snap.exists() && Object.keys(snap.val() || {}).length > 0;
}

// 이미 쓰는 코드와 겹치지 않는 새 코드
async function freshRoomCode() {
  for (let i = 0; i < 5; i++) {
    const c = randomCode();
    if (!(await roomExists(c))) return c;
  }
  return randomCode();   // 5번 다 겹칠 확률은 사실상 0
}

function randomCode() {
  const s = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = ""; for (let i = 0; i < 6; i++) c += s[Math.floor(Math.random() * s.length)];
  return c;
}

// 창 크기가 변하면 비율 좌표대로 즉시 재배치한다.
// (예전엔 다음 onValue를 기다렸는데, 아무도 안 움직이면 영영 어긋난 채로 남았다)
window.addEventListener("resize", () => {
  Object.values(actorEls).forEach(placeActor);
  if (inputBox.style.display === "block" && current) positionInput(current.a);
});
