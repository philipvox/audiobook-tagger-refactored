// src/context/AppContext.jsx
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [config, setConfig] = useState(null);
  const [groups, setGroups] = useState([]);
  const [fileStatuses, setFileStatuses] = useState({});
  const [writeProgress, setWriteProgress] = useState({ current: 0, total: 0 });
  const [isLoadingConfig, setIsLoadingConfig] = useState(true);

  // Global progress state for app-wide operations
  const [globalProgress, setGlobalProgress] = useState({
    active: false,
    current: 0,
    total: 0,
    message: '',
    detail: '',
    startTime: null,
    canCancel: false,
    type: 'info', // 'info', 'warning', 'danger', 'success'
    cancelFn: null
  });

  const cancelRef = useRef(null);

  // Load config on mount
  useEffect(() => {
    loadConfig();
  }, []);

  // Listen for write progress events
  useEffect(() => {
    const setupListener = async () => {
      const unlisten = await listen('write_progress', (event) => {
        console.log('📊 Write progress event received:', event.payload);
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
      setIsLoadingConfig(true); // ✅ ADD THIS
      const cfg = await invoke('get_config');
      setConfig(cfg);
    } catch (error) {
      console.error('Failed to load config:', error);
    } finally {
      setIsLoadingConfig(false); // ✅ ADD THIS
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

  // Global progress management functions
  const startGlobalProgress = useCallback(({ message, total = 0, canCancel = false, type = 'info', cancelFn = null }) => {
    cancelRef.current = cancelFn;
    setGlobalProgress({
      active: true,
      current: 0,
      total,
      message,
      detail: '',
      startTime: Date.now(),
      canCancel,
      type,
      cancelFn
    });
  }, []);

  const updateGlobalProgress = useCallback(({ current, total, message, detail }) => {
    setGlobalProgress(prev => ({
      ...prev,
      ...(current !== undefined && { current }),
      ...(total !== undefined && { total }),
      ...(message !== undefined && { message }),
      ...(detail !== undefined && { detail })
    }));
  }, []);

  const endGlobalProgress = useCallback(() => {
    cancelRef.current = null;
    setGlobalProgress({
      active: false,
      current: 0,
      total: 0,
      message: '',
      detail: '',
      startTime: null,
      canCancel: false,
      type: 'info',
      cancelFn: null
    });
  }, []);

  const cancelGlobalProgress = useCallback(() => {
    if (cancelRef.current) {
      cancelRef.current();
    }
    endGlobalProgress();
  }, [endGlobalProgress]);

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
    setWriteProgress,
    // Global progress
    globalProgress,
    startGlobalProgress,
    updateGlobalProgress,
    endGlobalProgress,
    cancelGlobalProgress
  };

  // ✅ CHANGE THIS - Show loading without unmounting children
  if (isLoadingConfig) {
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