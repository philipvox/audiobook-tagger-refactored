import { useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useApp } from '../context/AppContext';

export function useScan() {
  const { setGroups } = useApp();
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({
    current: 0,
    total: 0,
    currentFile: '',
    startTime: null,
    filesPerSecond: 0
  });
  
  const progressIntervalRef = useRef(null);
  const resetTimeoutRef = useRef(null);

  const calculateETA = useCallback(() => {
    if (!scanProgress.startTime || scanProgress.current === 0) return 'Calculating...';
    
    const elapsed = (Date.now() - scanProgress.startTime) / 1000;
    const rate = scanProgress.current / elapsed;
    const remaining = scanProgress.total - scanProgress.current;
    const eta = remaining / rate;
    
    if (eta < 60) return `${Math.round(eta)}s`;
    if (eta < 3600) return `${Math.round(eta / 60)}m ${Math.round(eta % 60)}s`;
    return `${Math.floor(eta / 3600)}h ${Math.round((eta % 3600) / 60)}m`;
  }, [scanProgress]);

  const handleScan = useCallback(async () => {
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
    
    if (resetTimeoutRef.current) {
      clearTimeout(resetTimeoutRef.current);
      resetTimeoutRef.current = null;
    }
    
    try {
      const selected = await open({
        directory: true,
        multiple: true,
      });
      
      if (!selected) return;
      
      const paths = Array.isArray(selected) ? selected : [selected];
      
      setScanning(true);
      const startTime = Date.now();
      setScanProgress({
        current: 0,
        total: 0,
        currentFile: '',
        startTime,
        filesPerSecond: 0
      });
      
      progressIntervalRef.current = setInterval(async () => {
        try {
          const progress = await invoke('get_scan_progress');
          const now = Date.now();
          const elapsed = (now - startTime) / 1000;
          const rate = progress.current > 0 && elapsed > 0 ? progress.current / elapsed : 0;
          
          setScanProgress({
            current: progress.current,
            total: progress.total,
            currentFile: progress.current_file || '',
            startTime,
            filesPerSecond: rate
          });
        } catch (error) {
          // Ignore polling errors
        }
      }, 500);
      
      try {
        const result = await invoke('scan_library', { paths });
        
        if (progressIntervalRef.current) {
          clearInterval(progressIntervalRef.current);
          progressIntervalRef.current = null;
        }
        
        setGroups(prevGroups => {
          const existingFilePaths = new Map();
          prevGroups.forEach(group => {
            group.files.forEach(file => {
              existingFilePaths.set(file.path, group.id);
            });
          });
          
          const groupIdsToReplace = new Set();
          const uniqueNewGroups = [];
          
          result.groups.forEach(newGroup => {
            const newGroupFilePaths = newGroup.files.map(f => f.path);
            
            newGroupFilePaths.forEach(path => {
              if (existingFilePaths.has(path)) {
                groupIdsToReplace.add(existingFilePaths.get(path));
              }
            });
            
            uniqueNewGroups.push(newGroup);
          });
          
          const filtered = prevGroups.filter(g => !groupIdsToReplace.has(g.id));
          return [...filtered, ...uniqueNewGroups];
        });
        
      } finally {
        if (progressIntervalRef.current) {
          clearInterval(progressIntervalRef.current);
          progressIntervalRef.current = null;
        }
        
        setScanning(false);
        
        resetTimeoutRef.current = setTimeout(() => {
          setScanProgress({
            current: 0,
            total: 0,
            currentFile: '',
            startTime: null,
            filesPerSecond: 0
          });
          resetTimeoutRef.current = null;
        }, 500);
      }
    } catch (error) {
      console.error('Scan failed:', error);
      
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
      
      if (resetTimeoutRef.current) {
        clearTimeout(resetTimeoutRef.current);
        resetTimeoutRef.current = null;
      }
      
      setScanning(false);
      setScanProgress({
        current: 0,
        total: 0,
        currentFile: '',
        startTime: null,
        filesPerSecond: 0
      });
    }
  }, [setGroups]);

  const handleRescan = useCallback(async (selectedFiles, groups) => {
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
    
    if (resetTimeoutRef.current) {
      clearTimeout(resetTimeoutRef.current);
      resetTimeoutRef.current = null;
    }
    
    try {
      setScanning(true);
      const startTime = Date.now();
      
      setScanProgress({
        current: 0,
        total: 0,
        currentFile: '',
        startTime,
        filesPerSecond: 0
      });
      
      progressIntervalRef.current = setInterval(async () => {
        try {
          const progress = await invoke('get_scan_progress');
          const now = Date.now();
          const elapsed = (now - startTime) / 1000;
          const rate = progress.current > 0 && elapsed > 0 ? progress.current / elapsed : 0;
          
          setScanProgress({
            current: progress.current,
            total: progress.total,
            currentFile: progress.current_file || '',
            startTime,
            filesPerSecond: rate
          });
        } catch (error) {
          // Ignore polling errors
        }
      }, 500);
      
      try {
        const groupsToRescan = [];
        const selectedFilePaths = new Set();
        
        groups.forEach(group => {
          const hasSelectedFile = group.files.some(f => selectedFiles.has(f.id));
          if (hasSelectedFile) {
            groupsToRescan.push(group);
            group.files.forEach(f => selectedFilePaths.add(f.path));
          }
        });

        if (groupsToRescan.length === 0) {
          return;
        }

        const foldersToRescan = new Set();
        groupsToRescan.forEach(group => {
          group.files.forEach(file => {
            const parts = file.path.split('/');
            parts.pop();
            const bookFolder = parts.join('/');
            foldersToRescan.add(bookFolder);
          });
        });

        const paths = Array.from(foldersToRescan);
        
        const allNewGroups = [];
        for (const path of paths) {
          try {
            const result = await invoke('scan_library', { paths: [path] });
            allNewGroups.push(...result.groups);
          } catch (error) {
            console.error(`Failed to scan ${path}:`, error);
          }
        }
        
        setGroups(prevGroups => {
          const filtered = prevGroups.filter(group => {
            const hasSelectedFile = group.files.some(file => 
              selectedFilePaths.has(file.path)
            );
            return !hasSelectedFile;
          });
          
          return [...filtered, ...allNewGroups];
        });
        
        return { success: true, count: allNewGroups.length };
        
      } finally {
        if (progressIntervalRef.current) {
          clearInterval(progressIntervalRef.current);
          progressIntervalRef.current = null;
        }
        
        setScanning(false);
        
        resetTimeoutRef.current = setTimeout(() => {
          setScanProgress({
            current: 0,
            total: 0,
            currentFile: '',
            startTime: null,
            filesPerSecond: 0
          });
          resetTimeoutRef.current = null;
        }, 500);
      }
    } catch (error) {
      console.error('Rescan failed:', error);
      
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
      
      if (resetTimeoutRef.current) {
        clearTimeout(resetTimeoutRef.current);
        resetTimeoutRef.current = null;
      }
      
      setScanning(false);
      throw error;
    }
  }, [setGroups]);

  const cancelScan = useCallback(async () => {
    try {
      await invoke('cancel_scan');
      
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
      
      if (resetTimeoutRef.current) {
        clearTimeout(resetTimeoutRef.current);
        resetTimeoutRef.current = null;
      }
      
      setScanning(false);
      setScanProgress({
        current: 0,
        total: 0,
        currentFile: '',
        startTime: null,
        filesPerSecond: 0
      });
    } catch (error) {
      console.error('Failed to cancel scan:', error);
    }
  }, []);

  return {
    scanning,
    scanProgress,
    calculateETA,
    handleScan,
    handleRescan,
    cancelScan,
  };
}