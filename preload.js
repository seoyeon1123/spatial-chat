// 렌더러 ↔ 메인 안전한 통신 다리
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  // 인터랙션 요소 위면 false(클릭 받기), 빈 곳이면 true(통과)
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  quit: () => ipcRenderer.send('quit-app'),
  // 메인 → 렌더러: 전역 단축키로 채팅 입력창 열기 요청
  onFocusChat: (cb) => ipcRenderer.on('focus-chat', () => cb()),
});
