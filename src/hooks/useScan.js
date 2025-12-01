// src/hooks/useScan.js
import { useState, useCallback, useRef, useEffect } from 'react';
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
    filesPerSecond: 0,
    covers_found: 0,
  });
  
  const progressIntervalRef = useRef(null);
  const resetTimeoutRef = useRef(null);

  useEffect(() => {
    return () => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
      }
      if (resetTimeoutRef.current) {
        clearTimeout(resetTimeoutRef.current);
      }
    };
  }, []);

  const calculateETA = useCallback(() => {
    const { current, total, startTime, filesPerSecond } = scanProgress;
    
    if (!startTime || current === 0 || filesPerSecond === 0) {
      return 'Calculating...';
    }
    
    const remaining = total - current;
    const secondsLeft = remaining / filesPerSecond;
    
    if (secondsLeft < 60) {
      return `${Math.round(secondsLeft)}s`;
    } else if (secondsLeft < 3600) {
      const mins = Math.floor(secondsLeft / 60);
      const secs = Math.round(secondsLeft % 60);
      return `${mins}m ${secs}s`;
    } else {
      const hours = Math.floor(secondsLeft / 3600);
      const mins = Math.floor((secondsLeft % 3600) / 60);
      return `${hours}h ${mins}m`;
    }
  }, [scanProgress]);

  const handleScan = useCallback(async () => {
    // Clean up any existing intervals
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
    
    if (resetTimeoutRef.current) {
      clearTimeout(resetTimeoutRef.current);
      resetTimeoutRef.current = null;
    }
    
    try {
      // OPEN FILE PICKER
      const selected = await open({
        directory: true,
        multiple: true,
      });
      
      if (!selected) {
        console.log('No folder selected');
        return;
      }
      
      const paths = Array.isArray(selected) ? selected : [selected];
      console.log('Scanning paths:', paths);
      
      setScanning(true);
      const startTime = Date.now();
      setScanProgress({
        current: 0,
        total: 0,
        currentFile: '',
        startTime,
        filesPerSecond: 0,
        covers_found: 0,
      });
      
      // Poll for progress
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
            filesPerSecond: rate,
            covers_found: progress.covers_found || 0,
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
        
        // Simple direct set - replace all groups
        if (result && result.groups) {
          setGroups(result.groups);
        }
        
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
            filesPerSecond: 0,
            covers_found: 0,
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
      throw error;
    }
  }, [setGroups]);

  // Import folders without metadata scanning
  const handleImport = useCallback(async () => {
    // Clean up any existing intervals
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }

    if (resetTimeoutRef.current) {
      clearTimeout(resetTimeoutRef.current);
      resetTimeoutRef.current = null;
    }

    try {
      // OPEN FILE PICKER
      const selected = await open({
        directory: true,
        multiple: true,
      });

      if (!selected) {
        console.log('No folder selected');
        return;
      }

      const paths = Array.isArray(selected) ? selected : [selected];
      console.log('Importing paths (no scan):', paths);

      setScanning(true);
      const startTime = Date.now();
      setScanProgress({
        current: 0,
        total: 0,
        currentFile: 'Importing folders...',
        startTime,
        filesPerSecond: 0,
        covers_found: 0,
      });

      try {
        const result = await invoke('import_folders', { paths });

        // Simple direct set - replace all groups
        if (result && result.groups) {
          setGroups(result.groups);
        }

      } finally {
        setScanning(false);

        resetTimeoutRef.current = setTimeout(() => {
          setScanProgress({
            current: 0,
            total: 0,
            currentFile: '',
            startTime: null,
            filesPerSecond: 0,
            covers_found: 0,
          });
          resetTimeoutRef.current = null;
        }, 500);
      }
    } catch (error) {
      console.error('Import failed:', error);
      setScanning(false);
      throw error;
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
      const selectedFilePaths = new Set();
      const pathsToScan = new Set();
      
      groups.forEach(group => {
        group.files.forEach(file => {
          if (selectedFiles.has(file.id)) {
            selectedFilePaths.add(file.path);
            const lastSlash = file.path.lastIndexOf('/');
            if (lastSlash > 0) {
              pathsToScan.add(file.path.substring(0, lastSlash));
            }
          }
        });
      });
      
      const paths = Array.from(pathsToScan);
      
      if (paths.length === 0) {
        return { success: false, count: 0 };
      }
      
      setScanning(true);
      const startTime = Date.now();
      setScanProgress({
        current: 0,
        total: 0,
        currentFile: '',
        startTime,
        filesPerSecond: 0,
        covers_found: 0,
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
            filesPerSecond: rate,
            covers_found: progress.covers_found || 0,
          });
        } catch (error) {
          // Ignore
        }
      }, 500);
      
      try {
        let allNewGroups = [];
        for (const path of paths) {
          try {
            const result = await invoke('scan_library', { paths: [path] });
            if (result && result.groups) {
              allNewGroups.push(...result.groups);
            }
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
            filesPerSecond: 0,
            covers_found: 0,
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
        filesPerSecond: 0,
        covers_found: 0,
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
    handleImport,
    handleRescan,
    cancelScan,
  };
}