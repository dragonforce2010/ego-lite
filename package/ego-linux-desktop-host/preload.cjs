const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('egoDesktop', {
  state: () => ipcRenderer.invoke('ego-ui', { action: 'state' }),
  act: (action, value) => ipcRenderer.invoke('ego-ui', { action, value }),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('ego-state', listener);
    return () => ipcRenderer.removeListener('ego-state', listener);
  },
});
