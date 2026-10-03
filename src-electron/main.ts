import { app, BrowserWindow, ipcMain, session, shell, WebContentsView } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type ViewMode = 'grid' | 'focus';
type Settings = { gameUrl: string; enabled: boolean[]; mode: ViewMode; activeSlot: number; economyMode: boolean };
type Layout = { mode: ViewMode; activeSlot: number; width: number; height: number; headerHeight: number };

const blankUrl = 'about:blank';
// Desligado por padrao: o jogo e idle e precisa continuar progredindo em segundo plano/minimizado nas 4 contas.
const defaults: Settings = {
  gameUrl: '',
  enabled: [true, true, true, true],
  mode: 'grid',
  activeSlot: 0,
  economyMode: false,
};
const expandedHeaderHeight = 176;
const gutter = 3;
let settings = { ...defaults };
let mainWindow: BrowserWindow | null = null;
let sessionViews: WebContentsView[] = [];
let lastLayout: Layout | null = null;

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

function readSettings(): Settings {
  try {
    const path = settingsPath();
    if (!existsSync(path)) return { ...defaults };
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Partial<Settings>;
    return {
      gameUrl: isWebUrl(saved.gameUrl) ? saved.gameUrl : '',
      enabled: Array.from({ length: 4 }, (_, i) => saved.enabled?.[i] !== false),
      mode: saved.mode === 'focus' ? 'focus' : 'grid',
      activeSlot: Number.isInteger(saved.activeSlot) ? Math.min(3, Math.max(0, saved.activeSlot!)) : 0,
      economyMode: typeof saved.economyMode === 'boolean' ? saved.economyMode : false,
    };
  } catch {
    return { ...defaults };
  }
}

function persistSettings(): void {
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

function isWebUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function emitStatus(slot: number, status: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('slot-status', { slot, status });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 860,
    minHeight: 620,
    title: 'PokeIdle Manager',
    backgroundColor: '#101714',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  sessionViews = Array.from({ length: 4 }, (_, slot) => {
    const view = new WebContentsView({
      webPreferences: {
        session: session.fromPartition(`persist:pokeidle-account-${slot + 1}`),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    view.webContents.setBackgroundThrottling(false);
    view.webContents.on('did-start-loading', () => emitStatus(slot, 'loading'));
    view.webContents.on('did-stop-loading', () => emitStatus(slot, 'ready'));
    view.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) emitStatus(slot, `error:${description}`);
    });
    view.webContents.on('will-navigate', (event, target) => {
      if (!isWebUrl(target)) event.preventDefault();
    });
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    mainWindow!.contentView.addChildView(view);
    return view;
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void mainWindow.loadURL(devUrl);
  else void mainWindow.loadFile(join(__dirname, '../renderer-dist/index.html'));

  mainWindow.on('resize', applyLayout);
  mainWindow.on('maximize', applyLayout);
  mainWindow.on('unmaximize', applyLayout);
  mainWindow.on('enter-full-screen', () => mainWindow?.webContents.send('fullscreen-changed', true));
  mainWindow.on('leave-full-screen', () => mainWindow?.webContents.send('fullscreen-changed', false));
  mainWindow.on('closed', () => {
    mainWindow = null;
    sessionViews = [];
  });
  enforceSlotContent();
}

// Carrega o jogo nas contas ativas e descarrega (about:blank) as desativadas para liberar RAM.
function enforceSlotContent(): void {
  sessionViews.forEach((view, slot) => {
    const shouldLoadGame = Boolean(settings.gameUrl) && settings.enabled[slot];
    const targetUrl = shouldLoadGame ? settings.gameUrl : blankUrl;
    if (view.webContents.getURL() !== targetUrl) void view.webContents.loadURL(targetUrl);
  });
}

function applyLayout(): void {
  if (!mainWindow || mainWindow.isDestroyed() || !sessionViews.length) return;
  const [width, height] = mainWindow.getContentSize();
  const layout = lastLayout ?? { mode: settings.mode, activeSlot: settings.activeSlot, width, height, headerHeight: expandedHeaderHeight };
  const headerHeight = Math.max(48, Math.min(240, layout.headerHeight));
  const areaHeight = Math.max(0, height - headerHeight);
  const cellWidth = layout.mode === 'grid' ? Math.floor((width - gutter) / 2) : width;
  const cellHeight = layout.mode === 'grid' ? Math.floor((areaHeight - gutter) / 2) : areaHeight;

  sessionViews.forEach((view, slot) => {
    let bounds = { x: 0, y: headerHeight, width: 1, height: 1 };
    let isVisible = false;
    if (settings.gameUrl && settings.enabled[slot]) {
      if (layout.mode === 'focus' && slot === layout.activeSlot) {
        bounds = { x: 0, y: headerHeight, width, height: areaHeight };
        isVisible = true;
      } else if (layout.mode === 'grid') {
        const column = slot % 2;
        const row = Math.floor(slot / 2);
        bounds = {
          x: column * (cellWidth + gutter),
          y: headerHeight + row * (cellHeight + gutter),
          width: cellWidth,
          height: cellHeight,
        };
        isVisible = true;
      }
    }
    view.setBounds(bounds);
    // No modo economia, contas ocultas no modo Foco ficam com throttling normal (menos CPU/RAM); a conta visivel continua em tempo real.
    view.webContents.setBackgroundThrottling(settings.economyMode ? !isVisible : false);
  });
}

ipcMain.handle('get-state', () => ({ ...settings }));
ipcMain.handle('toggle-fullscreen', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
  return mainWindow.isFullScreen();
});
ipcMain.handle('set-layout', (_event, layout: Layout) => {
  if (!layout || (layout.mode !== 'grid' && layout.mode !== 'focus')) return;
  settings.mode = layout.mode;
  settings.activeSlot = Math.min(3, Math.max(0, Number(layout.activeSlot) || 0));
  lastLayout = { ...layout, activeSlot: settings.activeSlot };
  applyLayout();
});
ipcMain.handle('save-settings', (_event, update: Partial<Settings>) => {
  const nextUrl = typeof update.gameUrl === 'string' ? update.gameUrl.trim() : settings.gameUrl;
  if (nextUrl && !isWebUrl(nextUrl)) throw new Error('Informe um endereco valido iniciado por http:// ou https://.');
  settings = {
    gameUrl: nextUrl,
    enabled: Array.from({ length: 4 }, (_, i) => update.enabled?.[i] ?? settings.enabled[i]),
    mode: update.mode === 'focus' ? 'focus' : update.mode === 'grid' ? 'grid' : settings.mode,
    activeSlot: Number.isInteger(update.activeSlot) ? Math.min(3, Math.max(0, update.activeSlot!)) : settings.activeSlot,
    economyMode: typeof update.economyMode === 'boolean' ? update.economyMode : settings.economyMode,
  };
  persistSettings();
  enforceSlotContent();
  applyLayout();
  return { ...settings };
});
ipcMain.handle('reload-slot', (_event, slot: number) => {
  if (Number.isInteger(slot) && slot >= 0 && slot < 4) sessionViews[slot]?.webContents.reload();
});
ipcMain.handle('open-slot', (_event, slot: number) => {
  if (Number.isInteger(slot) && slot >= 0 && slot < 4 && settings.gameUrl) {
    void sessionViews[slot]?.webContents.loadURL(settings.gameUrl);
  }
});
ipcMain.handle('get-memory-usage', () => {
  const metrics = app.getAppMetrics();
  return sessionViews.map(view => {
    const pid = view.webContents.getOSProcessId();
    const metric = metrics.find(item => item.pid === pid);
    const kilobytes = metric?.memory?.workingSetSize;
    return typeof kilobytes === 'number' ? Math.round(kilobytes / 1024) : null;
  });
});

app.whenReady().then(() => {
  settings = readSettings();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
