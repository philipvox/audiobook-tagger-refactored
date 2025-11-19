import { createContext, useContext, useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [config, setConfig] = useState(null);
  const [groups, setGroups] = useState([]);
  const [fileStatuses, setFileStatuses] = useState({});
  const [writeProgress, setWriteProgress] = useState({ current: 0, total: 0 });

  // Load config on mount
  useEffect(() => {
    loadConfig();
  }, []);

  // Listen for write progress events
  useEffect(() => {
    const setupListener = async () => {
      const unlisten = await listen('write_progress', (event) => {
        setWriteProgress(event.payload);
      });
      return unlisten;
    };
    
    let unlistenFn;
    setupListener().then(fn => { unlistenFn = fn; });
    
    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, []);

  const loadConfig = async () => {
    try {
      const cfg = await invoke('get_config');
      setConfig(cfg);
    } catch (error) {
      console.error('Failed to load config:', error);
    }
  };

  const saveConfig = async (newConfig) => {
    try {
      await invoke('save_config', { config: newConfig });
      setConfig(newConfig);
      return { success: true };
    } catch (error) {
      console.error('Failed to save config:', error);
      return { success: false, error: error.toString() };
    }
  };

  const updateFileStatus = (fileId, status) => {
    setFileStatuses(prev => ({
      ...prev,
      [fileId]: status
    }));
  };

  const updateFileStatuses = (statusMap) => {
    setFileStatuses(prev => ({
      ...prev,
      ...statusMap
    }));
  };

  const clearFileStatuses = () => {
    setFileStatuses({});
  };

  const value = {
    config,
    setConfig,
    loadConfig,
    saveConfig,
    groups,
    setGroups,
    fileStatuses,
    updateFileStatus,
    updateFileStatuses,
    clearFileStatuses,
    writeProgress,
    setWriteProgress
  };

  if (!config) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within AppProvider');
  }
  return context;
}
