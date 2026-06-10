// 렌더러: UI + Firebase 실시간 동기화
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase, ref, onValue, update, remove,
  onDisconnect, runTransaction, push, get, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const MAX_MEMBERS = 5;
const BUBBLE_MS = 4000;          // 말풍선 유지 시간
const CHARS = ["🐱","🐶","🦊","🐰","🐻","🐼","🐸","🦁","🐧","🐯","🐵","🐹"];

// ---------- Firebase ----------
let db = null;
try {
  const fbApp = initializeApp(firebaseConfig);
  db = getDatabase(fbApp);
} catch (e) {
  console.error("Firebase 초기화 실패:", e);
}

// ---------- 상태 ----------
let myChar = null, myNick = "", roomCode = "", myId = null;
let membersRef = null, myRef = null;
let myPos = { x: 0.5, y: 0.72 };     // 정규화 좌표(0~1)
const actorEls = {};                 // memberId -> {el, lastMsgAt}
let dragging = false;

// ---------- DOM ----------
const $ = (s) => document.querySelector(s);
const lobby = $("#lobby"), overlay = $("#overlay"), stage = $("#stage");
const inputBox = $("#inputBox"), chatInput = $("#chatInput");
let current = null;                  // 현재 입력 대상 actor

// ====== 클릭 통과 토글 (오버레이 핵심) ======
let ignoring = true;
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
const charGrid = $("#charGrid");
CHARS.forEach((c) => {
  const d = document.createElement("div");
  d.className = "char-pick"; d.textContent = c;
  d.onclick = () => {
    document.querySelectorAll(".char-pick").forEach((e) => e.classList.remove("sel"));
    d.classList.add("sel"); myChar = c; checkReady();
  };
  charGrid.appendChild(d);
});
const nickEl = $("#nick"), enterBtn = $("#enter"), roomCodeEl = $("#roomCode"), lobbyErr = $("#lobbyErr");
nickEl.oninput = checkReady;
function checkReady() { enterBtn.disabled = !(myChar && nickEl.value.trim()); }

enterBtn.onclick = join;

// 로비 닫기(앱 종료)
const lobbyCloseBtn = document.querySelector("#lobbyClose");
if (lobbyCloseBtn) lobbyCloseBtn.onclick = () => window.overlay?.quit();

// Esc: 입력창이 열려 있으면 닫고, 아니면 앱 종료
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (inputBox.style.display === "block") { hideInput(); return; }
  window.overlay?.quit();
});

async function join() {
  if (!db) { lobbyErr.textContent = "Firebase 초기화 실패 — firebase-config.js 확인"; return; }
  // 설정값이 아직 플레이스홀더면 바로 안내
  if (!firebaseConfig.databaseURL || firebaseConfig.databaseURL.includes("YOUR_PROJECT")) {
    lobbyErr.textContent = "firebase-config.js 에 본인 설정(databaseURL 포함)을 넣어주세요";
    return;
  }

  myNick = nickEl.value.trim();
  roomCode = (roomCodeEl.value.trim() || randomCode()).toUpperCase();
  enterBtn.disabled = true; lobbyErr.textContent = "연결 중…";

  membersRef = ref(db, `rooms/${roomCode}/members`);
  myId = push(membersRef).key;

  const newMember = { char: myChar, name: myNick, x: myPos.x, y: myPos.y, msg: "", msgAt: 0 };

  try {
    // 10초 안에 응답 없으면 연결 문제로 간주
    const tx = runTransaction(membersRef, (members) => {
      members = members || {};
      if (Object.keys(members).length >= MAX_MEMBERS) return;   // 정원 초과 → abort
      members[myId] = newMember;
      return members;
    });
    const res = await Promise.race([
      tx,
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 10000)),
    ]);

    if (!res.committed) {
      lobbyErr.textContent = "정원이 가득 찼어요 (최대 5명)";
      enterBtn.disabled = false; return;
    }
  } catch (e) {
    console.error("join 실패:", e);
    lobbyErr.textContent =
      e.message === "timeout"
        ? "Firebase 연결 실패 — databaseURL/Database 활성화/보안규칙 확인"
        : "오류: " + (e.message || e);
    enterBtn.disabled = false; return;
  }

  myRef = ref(db, `rooms/${roomCode}/members/${myId}`);
  onDisconnect(myRef).remove();
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
  $("#quitBtn").onclick = async () => {
    if (myRef) await remove(myRef);
    window.overlay?.quit();
  };

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
      el.innerHTML = `<div class="body">${m.char}</div><div class="name">${m.name}</div>`;
      stage.appendChild(el);
      a = actorEls[id] = { el, lastMsgAt: 0 };
      if (id === myId) makeDraggable(a);
      else el.querySelector(".body").onclick = (e) => { e.stopPropagation(); openInput(a, id); };
    }
    // 위치: 내 캐릭터는 로컬이 우선(드래그 중 흔들림 방지)
    if (id !== myId || !dragging) {
      const x = (id === myId ? myPos.x : m.x);
      const y = (id === myId ? myPos.y : m.y);
      a.el.style.left = x * window.innerWidth + "px";
      a.el.style.top = y * window.innerHeight + "px";
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
function openInput(a, id) {
  current = { a, id };
  const r = a.el.getBoundingClientRect();
  inputBox.style.left = r.left + r.width / 2 + "px";
  inputBox.style.top = r.top - 44 + "px";
  inputBox.style.display = "block";
  chatInput.value = ""; chatInput.focus();
}
function hideInput() { inputBox.style.display = "none"; current = null; }

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") return hideInput();
  if (e.key === "Enter" && chatInput.value.trim() && current) {
    sendMessage(chatInput.value.trim());
    hideInput();
  }
});

function sendMessage(text) {
  if (!myRef) return;
  // 내 노드에 메시지 기록 → 모두에게 동기화
  update(myRef, { msg: text, msgAt: serverTimestamp() });
  // 일정 시간 뒤 내 메시지 비우기(말풍선 만료)
  setTimeout(() => { if (myRef) update(myRef, { msg: "", msgAt: 0 }); }, BUBBLE_MS);
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
function randomCode() {
  const s = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = ""; for (let i = 0; i < 6; i++) c += s[Math.floor(Math.random() * s.length)];
  return c;
}

// 창 크기 변하면 캐릭터 위치 비율 유지 (다음 onValue 때 비율 기반으로 재배치됨)
window.addEventListener("resize", () => {
  Object.entries(actorEls).forEach(([id, a]) => {
    const left = parseFloat(a.el.style.left), top = parseFloat(a.el.style.top);
    // 즉시 반영은 생략 — 비율 좌표라 다음 동기화에서 자동 보정
  });
});
