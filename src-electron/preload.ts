import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('pokeManager', {
  getState: () => ipcRenderer.invoke('get-state'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('save-settings', settings),
  setLayout: (layout: unknown) => ipcRenderer.invoke('set-layout', layout),
  reloadSlot: (slot: number) => ipcRenderer.invoke('reload-slot', slot),
  openSlot: (slot: number) => ipcRenderer.invoke('open-slot', slot),
  getMemoryUsage: () => ipcRenderer.invoke('get-memory-usage'),
  toggleFullScreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  onFullScreenChange: (callback: (isFullScreen: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, isFullScreen: boolean) => callback(isFullScreen);
    ipcRenderer.on('fullscreen-changed', listener);
    return () => ipcRenderer.removeListener('fullscreen-changed', listener);
  },
  onSlotStatus: (callback: (payload: { slot: number; status: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { slot: number; status: string }) => callback(payload);
    ipcRenderer.on('slot-status', listener);
    return () => ipcRenderer.removeListener('slot-status', listener);
  },
});
