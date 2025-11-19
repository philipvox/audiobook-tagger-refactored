import { useState, useCallback } from 'react';
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
    try {
      const selected = await open({
        directory: true,
        multiple: true,
      });
      
      if (!selected) return;
      
      const paths = Array.isArray(selected) ? selected : [selected];
      setScanning(true);
      
      setScanProgress({
        current: 0,
        total: 0,
        currentFile: '',
        startTime: Date.now(),
        filesPerSecond: 0
      });
      
      const progressInterval = setInterval(async () => {
        try {
          const progress = await invoke('get_scan_progress');
          const elapsed = (Date.now() - scanProgress.startTime) / 1000;
          const rate = progress.current > 0 ? progress.current / elapsed : 0;
          
          setScanProgress(prev => ({
            ...prev,
            current: progress.current,
            total: progress.total,
            currentFile: progress.current_file || '',
            filesPerSecond: rate
          }));
        } catch (error) {
          // Progress endpoint might not exist yet
        }
      }, 500);
      
      try {
        const result = await invoke('scan_library', { paths });
        
        clearInterval(progressInterval);
        
        // Deduplicate and merge with existing groups
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
            
            let isDuplicate = false;
            newGroupFilePaths.forEach(path => {
              if (existingFilePaths.has(path)) {
                isDuplicate = true;
                groupIdsToReplace.add(existingFilePaths.get(path));
              }
            });
            
            uniqueNewGroups.push(newGroup);
          });
          
          const filtered = prevGroups.filter(g => !groupIdsToReplace.has(g.id));
          return [...filtered, ...uniqueNewGroups];
        });
        
      } finally {
        clearInterval(progressInterval);
        setScanning(false);
        setScanProgress({
          current: 0,
          total: 0,
          currentFile: '',
          startTime: null,
          filesPerSecond: 0
        });
      }
    } catch (error) {
      console.error('Scan failed:', error);
      setScanning(false);
      throw error;
    }
  }, [setGroups, scanProgress.startTime]);

  const handleRescan = useCallback(async (selectedFiles, groups) => {
    try {
      setScanning(true);
      
      setScanProgress({
        current: 0,
        total: 0,
        currentFile: '',
        startTime: Date.now(),
        filesPerSecond: 0
      });
      
      const progressInterval = setInterval(async () => {
        try {
          const progress = await invoke('get_scan_progress');
          
          if (progress.total > 0) {
            const elapsed = (Date.now() - scanProgress.startTime) / 1000;
            const rate = progress.current > 0 ? progress.current / elapsed : 0;
            
            setScanProgress(prev => ({
              ...prev,
              current: progress.current,
              total: progress.total,
              currentFile: progress.current_file || '',
              filesPerSecond: rate
            }));
          }
        } catch (error) {
          // Ignore
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
          clearInterval(progressInterval);
          setScanning(false);
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
        clearInterval(progressInterval);
        setScanning(false);
        setScanProgress({
          current: 0,
          total: 0,
          currentFile: '',
          startTime: null,
          filesPerSecond: 0
        });
      }
    } catch (error) {
      console.error('Rescan failed:', error);
      setScanning(false);
      throw error;
    }
  }, [setGroups, scanProgress.startTime]);

  const cancelScan = useCallback(async () => {
    try {
      await invoke('cancel_scan');
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
    cancelScan
  };
}
