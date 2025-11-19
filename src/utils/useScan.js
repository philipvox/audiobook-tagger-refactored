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