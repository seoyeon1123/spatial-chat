// Electron 메인 프로세스
// 역할: 투명 + 항상 위 + 클릭 통과(setIgnoreMouseEvents) 오버레이 창을 띄운다.
// 캐릭터/입력창 같은 인터랙션 요소 위에 마우스가 올라갔을 때만 클릭을 받도록
// 렌더러에서 IPC로 토글을 보내준다.

const { app, BrowserWindow, screen, ipcMain, globalShortcut } = require('electron');
const path = require('path');

let win = null;

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    transparent: true,      // 배경 투명
    frame: false,           // 타이틀바 없음
    resizable: false,
    movable: false,
    hasShadow: false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    alwaysOnTop: true,      // 항상 위
    skipTaskbar: true,      // 작업표시줄에 안 띄움
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 전체 화면 위에 깔되, 풀스크린 앱 위에도 뜨도록
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // 기본은 '클릭 가능'으로 시작 (로비 입력이 막히지 않도록).
  // 렌더러가 로드되면 빈 곳에선 통과(true), 요소 위에선 받기(false)로 토글한다.
  // forward:true 라서 통과 상태에서도 마우스 이동 이벤트는 계속 받는다.
  win.setIgnoreMouseEvents(false, { forward: true });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // win.webContents.openDevTools({ mode: 'detach' }); // 디버깅 시
}

// 렌더러 → 메인: 인터랙션 요소 위면 클릭 받게(false), 아니면 통과(true)
ipcMain.on('set-ignore-mouse', (_e, ignore) => {
  if (!win) return;
  win.setIgnoreMouseEvents(ignore, { forward: true });
});

// 창 종료
ipcMain.on('quit-app', () => app.quit());

app.whenReady().then(() => {
  createWindow();

  // 오버레이 토글 단축키 (Cmd/Ctrl+Shift+Space): 숨기기/보이기
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (!win) return;
    win.isVisible() ? win.hide() : win.show();
  });

  // 디버그용 개발자도구 토글 (Cmd/Ctrl+Shift+I) — 에러 확인할 때
  globalShortcut.register('CommandOrControl+Shift+I', () => {
    if (!win) return;
    const wc = win.webContents;
    wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools({ mode: 'detach' });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());

// 오버레이 앱이라 모든 창 닫혀도 트레이로 살아있게 하고 싶으면 여기 조정.
// 지금은 단순히 창 닫히면 종료.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
