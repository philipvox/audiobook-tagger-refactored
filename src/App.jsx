import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { FileAudio, RefreshCw, Wrench, Settings, Upload, UploadCloud, Save, ChevronRight, ChevronDown, Folder, Book, Files, FileSearch, FileType, AlertCircle, Zap, CheckCircle, Edit } from 'lucide-react';
import { RawTagInspector } from './components/RawTagInspector';
import { ConfirmModal } from './components/ConfirmModal';
import { RenamePreviewModal } from './components/RenamePreviewModal';
import { WritePreviewModal } from './components/WritePreviewModal';
import { listen } from '@tauri-apps/api/event';
import { EditMetadataModal } from './components/EditMetadataModal';

function App() {
  const [activeTab, setActiveTab] = useState('scanner');
  const [config, setConfig] = useState(null);
  const [groups, setGroups] = useState([]);
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [scanning, setScanning] = useState(false);
  const [writing, setWriting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState(new Set());
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [showTagInspector, setShowTagInspector] = useState(false);
  const [fileStatuses, setFileStatuses] = useState({});
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameFiles, setRenameFiles] = useState([]);
  const [renameMetadata, setRenameMetadata] = useState(null);
  const [showWritePreview, setShowWritePreview] = useState(false);
  const [confirmModal, setConfirmModal] = useState(null);
  const [lastSelectedIndex, setLastSelectedIndex] = useState(null);
  const [showEditModal, setShowEditModal] = useState(false);

const [editingGroup, setEditingGroup] = useState(null);
  const [scanProgress, setScanProgress] = useState({
    current: 0,
    total: 0,
    currentFile: '',
    startTime: null,
    filesPerSecond: 0
  });
  const [writeProgress, setWriteProgress] = useState({ current: 0, total: 0 });
const handleEditMetadata = (group) => {
  setEditingGroup(group);
  setShowEditModal(true);
};

const handleSaveMetadata = (newMetadata) => {
  if (!editingGroup) return;
  
  setGroups(prevGroups => 
    prevGroups.map(group => {
      if (group.id === editingGroup.id) {
        // Update ALL files in the group with new metadata
        const updatedFiles = group.files.map(file => {
          const changes = {};
          
          // Get old values from existing changes, or keep them empty
          const oldTitle = file.changes.title?.old || '';
          const oldAuthor = file.changes.author?.old || '';
          const oldNarrator = file.changes.narrator?.old || '';
          const oldGenre = file.changes.genre?.old || '';
          
          // Title change
          if (oldTitle !== newMetadata.title) {
            changes.title = { old: oldTitle, new: newMetadata.title };
          }
          
          // Author change
          if (oldAuthor !== newMetadata.author) {
            changes.author = { old: oldAuthor, new: newMetadata.author };
          }
          
          // Narrator change
          if (newMetadata.narrator) {
            const newNarratorValue = `Narrated by ${newMetadata.narrator}`;
            if (oldNarrator !== newNarratorValue) {
              changes.narrator = { old: oldNarrator, new: newNarratorValue };
            }
          }
          
          // Genre change
          if (newMetadata.genres.length > 0) {
            const newGenre = newMetadata.genres.join(', ');
            if (oldGenre !== newGenre) {
              changes.genre = { old: oldGenre, new: newGenre };
            }
          }
          
          // Series and year (these go in comments/custom tags)
          if (newMetadata.series) {
            changes.series = { old: '', new: newMetadata.series };
          }
          
          if (newMetadata.sequence) {
            changes.sequence = { old: '', new: newMetadata.sequence };
          }
          
          if (newMetadata.year) {
            changes.year = { old: file.changes.year?.old || '', new: newMetadata.year };
          }
          
          if (newMetadata.publisher) {
            changes.publisher = { old: '', new: newMetadata.publisher };
          }
          
          if (newMetadata.description) {
            changes.description = { old: '', new: newMetadata.description };
          }
          
          return {
            ...file,
            changes,
            status: Object.keys(changes).length > 0 ? 'changed' : 'unchanged'
          };
        });
        
        return {
          ...group,
          metadata: newMetadata,
          files: updatedFiles,
          total_changes: updatedFiles.filter(f => Object.keys(f.changes).length > 0).length
        };
      }
      return group;
    })
  );
  
  setEditingGroup(null);
};
const showConfirm = (config) => {
  setConfirmModal(config);
};

const hideConfirm = () => {
  setConfirmModal(null);
};

  useEffect(() => {
    loadConfig();
    
    // Listen for write progress
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
      alert('Settings saved!');
    } catch (error) {
      console.error('Failed to save config:', error);
      alert('Failed to save settings');
    }
  };
const calculateETA = () => {
  if (!scanProgress.startTime || scanProgress.current === 0) return 'Calculating...';
  
  const elapsed = (Date.now() - scanProgress.startTime) / 1000;
  const rate = scanProgress.current / elapsed;
  const remaining = scanProgress.total - scanProgress.current;
  const eta = remaining / rate;
  
  if (eta < 60) return `${Math.round(eta)}s`;
  if (eta < 3600) return `${Math.round(eta / 60)}m ${Math.round(eta % 60)}s`;
  return `${Math.floor(eta / 3600)}h ${Math.round((eta % 3600) / 60)}m`;
};
const handleScan = async () => {
  try {
    const selected = await open({
      directory: true,
      multiple: true,
    });
    
    if (!selected) return;
    
    const paths = Array.isArray(selected) ? selected : [selected];
    setScanning(true);
    
    // Reset progress
    setScanProgress({
      current: 0,
      total: 0,
      currentFile: '',
      startTime: Date.now(),
      filesPerSecond: 0
    });
    
    // Start periodic progress updates
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
        // Progress endpoint might not exist yet, ignore
      }
    }, 500);
    
    try {
      const result = await invoke('scan_library', { paths });
      
      clearInterval(progressInterval);
      
      // APPEND new groups with deduplication
      setGroups(prevGroups => {
        // ... existing deduplication logic stays the same ...
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
          
          if (!isDuplicate) {
            uniqueNewGroups.push(newGroup);
          } else {
            uniqueNewGroups.push(newGroup);
          }
        });
        
        const filtered = prevGroups.filter(g => !groupIdsToReplace.has(g.id));
        const finalGroups = [...filtered, ...uniqueNewGroups];
        
        if (uniqueNewGroups.length > 0) {
          setSelectedGroup(uniqueNewGroups[uniqueNewGroups.length - 1]);
        }
        
        if (groupIdsToReplace.size > 0) {
          console.log(`Replaced ${groupIdsToReplace.size} existing group(s)`);
        }
        if (uniqueNewGroups.length > groupIdsToReplace.size) {
          console.log(`Added ${uniqueNewGroups.length - groupIdsToReplace.size} new group(s)`);
        }
        
        return finalGroups;
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
    alert('Scan failed: ' + error);
  }
};
 const handleRescan = async () => {
    if (selectedFiles.size === 0) {
      showConfirm({
        title: "No Files Selected",
        message: "Please select files to rescan before proceeding.",
        confirmText: "OK",
        type: "info",
        onConfirm: () => {}
      });
      return;
    }

    showConfirm({
      title: "Rescan Selected Files",
      message: `Re-scan ${selectedFiles.size} selected file(s) for fresh metadata? This will fetch new data from APIs and may take a few moments.`,
      confirmText: "Rescan Files",
      type: "info",
      onConfirm: async () => {
        await performRescan();
      }
    });
  };

 const performRescan = async () => {
  try {
    setScanning(true);
    
    // Reset progress for rescan
    setScanProgress({
      current: 0,
      total: 0,
      currentFile: '',
      startTime: Date.now(),
      filesPerSecond: 0
    });
    
    // Start periodic progress updates (same as main scan)
    const progressInterval = setInterval(async () => {
      try {
        const progress = await invoke('get_scan_progress');
        console.log('Rescan progress update:', progress); // DEBUG LOG
        
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
        console.log('Rescan progress fetch error:', error); // DEBUG LOG
      }
    }, 500);
    
    try {
      // Get the groups that contain selected files
      const groupsToRescan = [];
      const selectedFilePaths = new Set();
      
      groups.forEach(group => {
        const hasSelectedFile = group.files.some(f => selectedFiles.has(f.id));
        if (hasSelectedFile) {
          groupsToRescan.push(group);
          // Track all file paths from this group
          group.files.forEach(f => selectedFilePaths.add(f.path));
        }
      });

      if (groupsToRescan.length === 0) {
        clearInterval(progressInterval);
        setScanning(false);
        return;
      }

      console.log('Groups to rescan:', groupsToRescan.length);
      
      // Get unique folder paths at the book level
      const foldersToRescan = new Set();
      groupsToRescan.forEach(group => {
        group.files.forEach(file => {
          const parts = file.path.split('/');
          parts.pop(); // Remove filename
          const bookFolder = parts.join('/');
          foldersToRescan.add(bookFolder);
        });
      });

      const paths = Array.from(foldersToRescan);
      console.log('Rescanning paths:', paths);
      
      // Rescan each folder individually
      const allNewGroups = [];
      for (const path of paths) {
        try {
          const result = await invoke('scan_library', { paths: [path] });
          console.log(`Scanned ${path}: got ${result.groups.length} groups`);
          allNewGroups.push(...result.groups);
        } catch (error) {
          console.error(`Failed to scan ${path}:`, error);
        }
      }
      
      console.log('Total new groups from rescan:', allNewGroups.length);
      
      // Update state
      setGroups(prevGroups => {
        const filtered = prevGroups.filter(group => {
          const hasSelectedFile = group.files.some(file => 
            selectedFilePaths.has(file.path)
          );
          return !hasSelectedFile;
        });
        
        return [...filtered, ...allNewGroups];
      });
      
      // Auto-select the last rescanned group
      if (allNewGroups.length > 0) {
        setSelectedGroup(allNewGroups[allNewGroups.length - 1]);
      }
      
      // Clear selections and statuses
      setSelectedFiles(new Set());
      setFileStatuses({});
      
      showConfirm({
        title: "Rescan Complete",
        message: `Successfully rescanned ${allNewGroups.length} book(s).`,
        confirmText: "OK",
        type: "info",
        onConfirm: () => {}
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
    console.error('Rescan failed:', error);
    setScanning(false);
    showConfirm({
      title: "Rescan Failed",
      message: `Failed to rescan: ${error}`,
      confirmText: "OK",
      type: "danger",
      onConfirm: () => {}
    });
  }
};
 const handleWrite = async () => {
  if (selectedFiles.size === 0) {
    showConfirm({
      title: "No Files Selected",
      message: "Please select files to write tags to before proceeding.",
      confirmText: "OK",
      type: "info",
      onConfirm: () => {}
    });
    return;
  }

  // Check if any selected files have changes
  const filesWithChanges = [];
  groups.forEach(group => {
    group.files.forEach(file => {
      if (selectedFiles.has(file.id) && Object.keys(file.changes).length > 0) {
        filesWithChanges.push(file);
      }
    });
  });

  if (filesWithChanges.length === 0) {
    showConfirm({
      title: "No Changes to Write",
      message: "The selected files don't have any pending changes to write.",
      confirmText: "OK",
      type: "info",
      onConfirm: () => {}
    });
    return;
  }

  // Show the preview modal instead of confirmation
  setShowWritePreview(true);
};
const performWrite = async () => {
  try {
    setWriting(true);
    setWriteProgress({ current: 0, total: selectedFiles.size });  // ADD THIS

    const filesMap = {};
    groups.forEach(group => {
      group.files.forEach(file => {
        filesMap[file.id] = {
          path: file.path,
          changes: file.changes
        };
      });
    });
    
    const result = await invoke('write_tags', { 
      request: {
        file_ids: Array.from(selectedFiles),
        files: filesMap,
        backup: config.backup_tags
      }
    });

    const newStatuses = { ...fileStatuses };
    Array.from(selectedFiles).forEach(fileId => {
      const hasError = result.errors.some(e => e.file_id === fileId);
      newStatuses[fileId] = hasError ? 'failed' : 'success';
    });
    setFileStatuses(newStatuses);
    
    setWriting(false);
    
    if (result.failed > 0) {
      showConfirm({
        title: "Write Results",
        message: `Successfully written: ${result.success} files\nFailed: ${result.failed} files\n\nCheck the status indicators for details.`,
        confirmText: "OK",
        type: "warning",
        onConfirm: () => {}
      });
    } else {
      showConfirm({
        title: "Write Complete",
        message: `Successfully wrote tags to ${result.success} files!`,
        confirmText: "OK",
        type: "info",
        onConfirm: () => {
          setSelectedFiles(new Set());
        }
      });
    }
  } catch (error) {
    console.error('Write failed:', error);
    setWriting(false);
    showConfirm({
      title: "Write Failed",
      message: `Failed to write tags: ${error}`,
      confirmText: "OK",
      type: "danger",
      onConfirm: () => {}
    });
  }
};

  const handleRename = () => {
    if (selectedFiles.size === 0) {
      showConfirm({
        title: "No Files Selected",
        message: "Please select files to rename before proceeding.",
        confirmText: "OK",
        type: "info",
        onConfirm: () => {}
      });
      return;
    }

    const filesToRename = [];
    const metadataMap = new Map();

    groups.forEach(group => {
      group.files.forEach(file => {
        if (selectedFiles.has(file.id)) {
          filesToRename.push(file.path);
          metadataMap.set(file.path, group.metadata);
        }
      });
    });

    if (filesToRename.length === 0) return;

    setRenameFiles(filesToRename);
    setRenameMetadata(metadataMap.get(filesToRename[0]));
    setShowRenameModal(true);
  };

  const handleRenameConfirm = async () => {
    setShowRenameModal(false);
    setWriting(true);

    try {
      const filePairs = renameFiles.map(path => {
        let metadata = null;
        groups.forEach(group => {
          const file = group.files.find(f => f.path === path);
          if (file) metadata = group.metadata;
        });
        return [path, metadata];
      }).filter(([_, meta]) => meta !== null);

      const result = await invoke('rename_files', { files: filePairs });
      
      const renamed = result.filter(r => r.changed).length;
      alert(`Successfully renamed ${renamed} file(s)!`);
      
      setWriting(false);
      
      await handleScan();
    } catch (error) {
      console.error('Rename failed:', error);
      setWriting(false);
      alert('Rename failed: ' + error);
    }
  };
  const handlePush = async () => {
    const successfulFileIds = Array.from(selectedFiles).filter(id => fileStatuses[id] === 'success');
    
    if (successfulFileIds.length === 0) {
      showConfirm({
        title: "No Files Ready",
        message: "No successfully written files to push. Please write tags first.",
        confirmText: "OK",
        type: "info",
        onConfirm: () => {}
      });
      return;
    }

    const skippedCount = selectedFiles.size - successfulFileIds.length;
    if (skippedCount > 0) {
      showConfirm({
        title: "Push to AudiobookShelf",
        message: `Push ${successfulFileIds.length} successfully written files to AudiobookShelf?\n\nNote: ${skippedCount} failed/unwritten files will be skipped.`,
        confirmText: `Push ${successfulFileIds.length} Files`,
        type: "warning",
        onConfirm: () => performPush(successfulFileIds)
      });
    } else {
      showConfirm({
        title: "Push to AudiobookShelf",
        message: `Push ${successfulFileIds.length} file(s) to AudiobookShelf server?`,
        confirmText: `Push ${successfulFileIds.length} Files`,
        type: "info",
        onConfirm: () => performPush(successfulFileIds)
      });
    }
  };

  const performPush = async (successfulFileIds) => {
    try {
      setPushing(true);
      
      const items = [];
      groups.forEach(group => {
        group.files.forEach(file => {
          if (successfulFileIds.includes(file.id)) {
            items.push({
              path: file.path,
              metadata: group.metadata
            });
          }
        });
      });

      const result = await invoke('push_abs_updates', { request: { items } });
      setPushing(false);

      let message = `Updated ${result.updated || 0} item${result.updated === 1 ? '' : 's'} in AudiobookShelf.`;

      if (result.unmatched && result.unmatched.length > 0) {
        message += `\n\nUnmatched files: ${result.unmatched.slice(0, 5).join(', ')}${
          result.unmatched.length > 5 ? '...' : ''
        }`;
      }

      if (result.failed && result.failed.length > 0) {
        const failures = result.failed
          .slice(0, 5)
          .map((f) => `${f.path}${f.reason ? ` (${f.reason})` : ''}`)
          .join(', ');
        message += `\n\nFailed: ${failures}${result.failed.length > 5 ? '...' : ''}`;
      }

      showConfirm({
        title: "Push Complete",
        message: message,
        confirmText: "OK",
        type: result.failed?.length > 0 ? "warning" : "info",
        onConfirm: () => {}
      });
    } catch (error) {
      console.error('Push to AudiobookShelf failed:', error);
      setPushing(false);
      showConfirm({
        title: "Push Failed",
        message: `Failed to push updates: ${error}`,
        confirmText: "OK",
        type: "danger",
        onConfirm: () => {}
      });
    }
  };
const cancelScan = async () => {
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
};
  const toggleGroup = (groupId) => {
    const newExpanded = new Set(expandedGroups);
    if (newExpanded.has(groupId)) {
      newExpanded.delete(groupId);
    } else {
      newExpanded.add(groupId);
    }
    setExpandedGroups(newExpanded);
  };

  const selectAllInGroup = (group, checked) => {
    const newSelected = new Set(selectedFiles);
    group.files.forEach(file => {
      if (checked) {
        newSelected.add(file.id);
      } else {
        newSelected.delete(file.id);
      }
    });
    setSelectedFiles(newSelected);
  };

  const getGroupIcon = (type) => {
    if (type === 'single') return <Book className="w-4 h-4" />;
    if (type === 'series') return <Folder className="w-4 h-4" />;
    return <Files className="w-4 h-4" />;
  };

  const getFileStatusIcon = (fileId) => {
    const status = fileStatuses[fileId];
    if (status === 'success') return <span className="text-green-600 font-bold">✓</span>;
    if (status === 'failed') return <span className="text-red-600 font-bold">✗</span>;
    return null;
  };

  const getSuccessCount = () => {
    return Array.from(selectedFiles).filter(id => fileStatuses[id] === 'success').length;
  };

  const getFailedCount = () => {
    return Array.from(selectedFiles).filter(id => fileStatuses[id] === 'failed').length;
  };

  const testConnection = async () => {
    try {
      const result = await invoke('test_abs_connection', { config });
      alert(result.message);
    } catch (error) {
      alert('Connection test failed: ' + error);
    }
  };

  if (!config) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <FileAudio className="w-8 h-8 text-red-600" />
            <h1 className="text-2xl font-bold text-gray-900">Audiobook Tagger</h1>
          </div>
          
          <div className="flex items-center gap-4">
            <button onClick={handleScan} disabled={scanning} className="btn btn-primary flex items-center gap-2">
              <RefreshCw className={`w-4 h-4 ${scanning ? 'animate-spin' : ''}`} />
              {scanning ? 'Scanning...' : 'Scan Library'}
            </button>
            <button
              onClick={() => setShowTagInspector(true)}
              className="btn btn-secondary flex items-center gap-2"
            >
              <FileSearch className="w-4 h-4" />
              Inspect Tags
            </button>
          </div>
        </div>
      </header>
      {/* Smart Contextual Action Bar */}
      {selectedFiles.size > 0 && (
        <div className="bg-blue-50 border-b border-blue-200 px-6 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 text-sm">
              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-blue-600" />
                <span className="font-medium text-blue-900">
                  {selectedFiles.size === 1 ? '1 file' : `${selectedFiles.size} files`} selected
                </span>
              </div>
              
              {/* Show status breakdown for multiple files */}
              {selectedFiles.size > 1 && (
                <div className="flex items-center gap-3 text-xs">
                  {(() => {
                    const selectedArray = Array.from(selectedFiles);
                    const withChanges = selectedArray.filter(id => {
                      // Find the file and check if it has changes
                      for (const group of groups) {
                        const file = group.files.find(f => f.id === id);
                        if (file && Object.keys(file.changes).length > 0) return true;
                      }
                      return false;
                    }).length;
                    
                    const written = selectedArray.filter(id => fileStatuses[id] === 'success').length;
                    const failed = selectedArray.filter(id => fileStatuses[id] === 'failed').length;
                    
                    return (
                      <>
                        {withChanges > 0 && <span className="text-amber-600">{withChanges} with changes</span>}
                        {written > 0 && <span className="text-green-600">{written} written</span>}
                        {failed > 0 && <span className="text-red-600">{failed} failed</span>}
                      </>
                    );
                  })()}
                </div>
              )}
              
              <button 
                onClick={() => setSelectedFiles(new Set())}
                className="text-blue-600 hover:text-blue-800 underline"
              >
                Clear
              </button>
            </div>
            
            <div className="flex items-center gap-3">
              {/* Always show rescan for selected files */}
              <button 
                onClick={handleRescan} 
                disabled={scanning} 
                className="px-4 py-2 bg-white border border-blue-300 text-blue-700 rounded-lg hover:bg-blue-50 transition-colors font-medium flex items-center gap-2"
              >
                <RefreshCw className={`w-4 h-4 ${scanning ? 'animate-spin' : ''}`} />
                {scanning ? 'Rescanning...' : `Rescan ${selectedFiles.size === 1 ? 'File' : `${selectedFiles.size} Files`}`}
              </button>
              
              {/* Show write button only if files have changes */}
              {(() => {
                const filesWithChanges = Array.from(selectedFiles).filter(id => {
                  for (const group of groups) {
                    const file = group.files.find(f => f.id === id);
                    if (file && Object.keys(file.changes).length > 0) return true;
                  }
                  return false;
                });
                
                return filesWithChanges.length > 0 ? (
                  <button 
                    onClick={handleWrite} 
                    disabled={writing} 
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium flex items-center gap-2"
                  >
                    <Save className="w-4 h-4" />
                    {writing ? 'Writing...' : `Write ${filesWithChanges.length} File${filesWithChanges.length === 1 ? '' : 's'}`}
                  </button>
                ) : null;
              })()}
              
              {/* Show rename only for single file or single book group */}
              {(() => {
                const selectedGroups = new Set();
                groups.forEach(group => {
                  if (group.files.some(f => selectedFiles.has(f.id))) {
                    selectedGroups.add(group.id);
                  }
                });
                
                return selectedGroups.size === 1 ? (
                  <button 
                    onClick={handleRename} 
                    disabled={writing} 
                    className="px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium flex items-center gap-2"
                  >
                    <FileType className="w-4 h-4" />
                    Rename {selectedFiles.size === 1 ? 'File' : 'Files'}
                  </button>
                ) : null;
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Success Action Bar - only for successfully written files */}
      {getSuccessCount() > 0 && (
        <div className="bg-green-50 border-b border-green-200 px-6 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 text-sm">
              <CheckCircle className="w-4 h-4 text-green-600" />
              <span className="font-medium text-green-900">
                {getSuccessCount()} file{getSuccessCount() === 1 ? '' : 's'} successfully written
              </span>
              <span className="text-green-700">Ready to push to AudiobookShelf</span>
            </div>
            
            <button
              onClick={handlePush}
              disabled={pushing}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium flex items-center gap-2"
            >
              <UploadCloud className={`w-4 h-4 ${pushing ? 'animate-pulse' : ''}`} />
              {pushing ? 'Pushing…' : `Push ${getSuccessCount()} to AudiobookShelf`}
            </button>
          </div>
        </div>
      )}
      <nav className="bg-white border-b border-gray-200 px-6">
        <div className="flex gap-1">
          <button
            onClick={() => setActiveTab('scanner')}
            className={`px-4 py-2 font-medium transition-colors ${
              activeTab === 'scanner'
                ? 'text-red-600 border-b-2 border-red-600'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            <div className="flex items-center gap-2">
              <RefreshCw className="w-4 h-4" />
              Scanner
            </div>
          </button>
          <button
            onClick={() => setActiveTab('maintenance')}
            className={`px-4 py-2 font-medium transition-colors ${
              activeTab === 'maintenance'
                ? 'text-red-600 border-b-2 border-red-600'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            <div className="flex items-center gap-2">
              <Wrench className="w-4 h-4" />
              Maintenance
            </div>
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={`px-4 py-2 font-medium transition-colors ${
              activeTab === 'settings'
                ? 'text-red-600 border-b-2 border-red-600'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            <div className="flex items-center gap-2">
              <Settings className="w-4 h-4" />
              Settings
            </div>
          </button>
        </div>
      </nav>

      <main className="flex-1 overflow-y-auto">
        {activeTab === 'scanner' && (
          <div className="h-full flex bg-gray-50">
            {/* Left Panel - Book List */}
            <div className="w-2/5 border-r border-gray-200 overflow-y-auto bg-white flex flex-col">
              {groups.length === 0 ? (
                <div className="flex-1 flex items-center justify-center p-8">
                  <div className="text-center max-w-sm">
                    <div className="bg-gradient-to-br from-blue-50 to-indigo-100 rounded-2xl p-8 border border-blue-200">
                      <Upload className="w-12 h-12 text-blue-400 mx-auto mb-4" />
                      <h3 className="text-lg font-semibold text-gray-900 mb-2">No Files Scanned</h3>
                      <p className="text-gray-600 mb-6 text-sm">Select a folder to scan for audiobook files and view metadata</p>
                      <button 
                        onClick={handleScan} 
                        disabled={scanning}
                        className="w-full px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium disabled:opacity-50"
                      >
                        {scanning ? 'Scanning...' : 'Scan Library'}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  {/* Compact Stats Header */}
                  <div className="border-b border-gray-200 p-4 bg-gray-50">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-6 text-sm">
                        <span className="font-semibold text-gray-900">
                          {groups.length} book{groups.length === 1 ? '' : 's'}
                        </span>
                        <span className="text-gray-600">
                          {groups.reduce((sum, g) => sum + g.files.length, 0)} files
                        </span>
                        <span className="text-amber-600">
                          {groups.reduce((sum, g) => sum + g.total_changes, 0)} changes
                        </span>
                        {getSuccessCount() > 0 && (
                          <span className="text-green-600 font-medium">
                            ✓ {getSuccessCount()} written
                          </span>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            const allGroupIds = groups.flatMap(g => g.files.map(f => f.id));
                            setSelectedFiles(new Set(allGroupIds));
                          }}
                          className="px-3 py-1.5 text-xs bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 rounded-md transition-colors"
                        >
                          Select All
                        </button>
                        <button
                          onClick={() => setSelectedFiles(new Set())}
                          className="px-3 py-1.5 text-xs bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 rounded-md transition-colors"
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Clean Book List */}
                  <div className="flex-1 overflow-y-auto">
                    {groups.map((group, index) => (
                      <div 
                        key={group.id} 
                        className={`border-b border-gray-100 hover:bg-gray-50 transition-colors cursor-pointer ${
                          selectedGroup?.id === group.id ? 'bg-blue-50 border-r-4 border-blue-500' : ''
                        }`}
                        onClick={(e) => {
                          if (e.shiftKey && lastSelectedIndex !== null) {
                            // Shift+click: select range
                            const currentIndex = index;
                            const start = Math.min(lastSelectedIndex, currentIndex);
                            const end = Math.max(lastSelectedIndex, currentIndex);
                            
                            const newSelected = new Set(selectedFiles);
                            for (let i = start; i <= end; i++) {
                              groups[i].files.forEach(file => {
                                newSelected.add(file.id);
                              });
                            }
                            setSelectedFiles(newSelected);
                            setLastSelectedIndex(currentIndex);
                          } else {
                            // Normal click: just select this group for viewing
                            setSelectedGroup(group);
                            setLastSelectedIndex(index);
                          }
                        }}
                      >
                        <div className="p-4">
                          <div className="flex items-start gap-3">
                            {/* Checkbox */}
                            <input
                              type="checkbox"
                              checked={group.files.every(f => selectedFiles.has(f.id))}
                              onChange={(e) => {
                                e.stopPropagation();
                                selectAllInGroup(group, e.target.checked);
                                setLastSelectedIndex(index);
                              }}
                              className="mt-1 w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                            />

                            {/* Book Info */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-start justify-between mb-2">
                                <h4 className="font-medium text-gray-900 text-sm leading-tight truncate pr-2">
                                  {group.metadata.title}
                                </h4>
                                <div className="flex items-center gap-1 flex-shrink-0">
                                  {group.total_changes > 0 && (
                                    <span className="px-2 py-0.5 bg-yellow-100 text-yellow-800 text-xs rounded-full font-medium">
                                      {group.total_changes}
                                    </span>
                                  )}
                                  {getSuccessCount() > 0 && group.files.some(f => fileStatuses[f.id] === 'success') && (
                                    <CheckCircle className="w-4 h-4 text-green-600" />
                                  )}
                                </div>
                              </div>
                              
                              <p className="text-sm text-gray-600 mb-2 leading-relaxed">
                                by {group.metadata.author}
                              </p>
                              
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3 text-xs text-gray-500">
                                  <span>{group.files.length} file{group.files.length === 1 ? '' : 's'}</span>
                                  <span className="capitalize">{group.group_type}</span>
                                </div>
                                
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleGroup(group.id);
                                  }}
                                  className="p-1 hover:bg-gray-200 rounded transition-colors"
                                >
                                  {expandedGroups.has(group.id) ? (
                                    <ChevronDown className="w-4 h-4 text-gray-500" />
                                  ) : (
                                    <ChevronRight className="w-4 h-4 text-gray-500" />
                                  )}
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                        
                        {/* Expanded Files */}
                        {expandedGroups.has(group.id) && (
                          <div className="bg-gray-50 border-t border-gray-200">
                            {group.files.map((file) => (
                              <div
                                key={file.id}
                                className="px-4 py-3 hover:bg-gray-100 transition-colors border-b border-gray-200 last:border-b-0"
                              >
                                <div className="flex items-center gap-3 pl-7">
                                  <input
                                    type="checkbox"
                                    checked={selectedFiles.has(file.id)}
                                    onChange={(e) => {
                                      e.stopPropagation();
                                      const newSet = new Set(selectedFiles);
                                      if (newSet.has(file.id)) {
                                        newSet.delete(file.id);
                                      } else {
                                        newSet.add(file.id);
                                      }
                                      setSelectedFiles(newSet);
                                    }}
                                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                                  />
                                  
                                  <div className="flex items-center gap-2">
                                    {getFileStatusIcon(file.id)}
                                    <FileAudio className="w-4 h-4 text-gray-400" />
                                  </div>
                                  
                                  <div className="flex-1 min-w-0">
                                    <div className="text-sm text-gray-900 truncate">
                                      {file.filename}
                                    </div>
                                    {Object.keys(file.changes).length > 0 && (
                                      <div className="text-xs text-amber-600 mt-0.5">
                                        {Object.keys(file.changes).length} pending changes
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Right Panel - Metadata Display */}
            <div className="flex-1 overflow-y-auto">
              {!selectedGroup ? (
                <div className="h-full flex items-center justify-center">
                  <div className="text-center max-w-md px-6">
                    <div className="bg-white rounded-2xl p-8 border border-gray-200 shadow-sm">
                      <Book className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                      <h3 className="text-lg font-semibold text-gray-900 mb-2">Select a Book</h3>
                      <p className="text-gray-600 text-sm">Choose a book from the list to view its metadata and processing details.</p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-6">
                <MetadataDisplay 
                  metadata={selectedGroup.metadata} 
                  groupInfo={selectedGroup}
                  onEdit={() => handleEditMetadata(selectedGroup)}
                />
              </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'maintenance' && (
          <MaintenanceTab />
        )}

        {activeTab === 'settings' && (
          <SettingsTab config={config} setConfig={setConfig} saveConfig={saveConfig} testConnection={testConnection} />
        )}
      </main>

      {showTagInspector && (
        <RawTagInspector 
          isOpen={showTagInspector} 
          onClose={() => setShowTagInspector(false)} 
        />
      )}

      {showRenameModal && (
        <RenamePreviewModal
          selectedFiles={renameFiles}
          metadata={renameMetadata}
          onConfirm={handleRenameConfirm}
          onCancel={() => setShowRenameModal(false)}
        />
      )}

      {/* ADD THE BOTTOM PROGRESS BAR HERE - RIGHT BEFORE THE CONFIRMATION MODAL */}
      {scanning && scanProgress.total > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg z-50">
          <div className="px-6 py-4">
            {/* Progress Info Row */}
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <RefreshCw className="w-5 h-5 text-blue-600 animate-spin" />
                  <span className="font-semibold text-gray-900">
                    Scanning {scanProgress.current} of {scanProgress.total} files
                  </span>
                </div>
                <button 
                  onClick={cancelScan}
                  className="px-3 py-1.5 bg-red-100 hover:bg-red-200 text-red-700 text-sm font-medium rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <div className="text-sm text-gray-600">
                    {scanProgress.total > 0 ? Math.round((scanProgress.current / scanProgress.total) * 100) : 0}% complete
                  </div>
              </div>
              
              <div className="text-right">
                <div className="font-semibold text-gray-900">
                  ETA: {calculateETA()}
                </div>
                <div className="text-sm text-gray-600">
                  {Math.round((scanProgress.current / scanProgress.total) * 100)}% complete
                </div>
              </div>
            </div>
            
            {/* Progress Bar */}
            <div className="mb-3">
              <div className="w-full bg-gray-200 rounded-full h-3">
                <div 
                  className="bg-gradient-to-r from-blue-500 to-blue-600 h-3 rounded-full transition-all duration-300"
                  style={{ 
                    width: `${scanProgress.total > 0 ? Math.max(2, (scanProgress.current / scanProgress.total) * 100) : 0}%` 
                  }}
                ></div>
              </div>
            </div>
            
            {/* Current File */}
            {scanProgress.currentFile && (
              <div className="text-sm text-gray-700 truncate">
                <span className="font-medium">Processing:</span> {scanProgress.currentFile}
              </div>
            )}
          </div>
        </div>
      )}
      {/* Write Progress Bar */}
      {writing && writeProgress.total > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg z-50">
          <div className="px-6 py-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Save className="w-5 h-5 text-blue-600 animate-pulse" />
                <span className="font-semibold text-gray-900">
                  Writing tags {writeProgress.current} of {writeProgress.total}
                </span>
              </div>
              <div className="text-sm text-gray-600">
                {Math.round((writeProgress.current / writeProgress.total) * 100)}% complete
              </div>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-3">
              <div 
                className="bg-blue-600 h-3 rounded-full transition-all duration-300"
                style={{ width: `${writeProgress.total > 0 ? (writeProgress.current / writeProgress.total) * 100 : 0}%` }}
              ></div>
            </div>
          </div>
        </div>
      )}
      {/* Custom Confirmation Modal */}
      {confirmModal && (
        <ConfirmModal
          isOpen={true}
          onClose={hideConfirm}
          onConfirm={confirmModal.onConfirm}
          title={confirmModal.title}
          message={confirmModal.message}
          confirmText={confirmModal.confirmText}
          cancelText={confirmModal.cancelText}
          type={confirmModal.type}
        />
      )}
      {showWritePreview && (
        <WritePreviewModal
          isOpen={showWritePreview}
          onClose={() => setShowWritePreview(false)}
          onConfirm={performWrite}
          selectedFiles={selectedFiles}
          groups={groups}
          backupEnabled={config.backup_tags}
        />
      )}
       {showEditModal && editingGroup && (
        <EditMetadataModal
          isOpen={showEditModal}
          onClose={() => {
            setShowEditModal(false);
            setEditingGroup(null);
          }}
          onSave={handleSaveMetadata}
          metadata={editingGroup.metadata}
          groupName={editingGroup.group_name}
        />
      )}
      {/* Custom Confirmation Modal */}
      {confirmModal && (
        <ConfirmModal
          isOpen={true}
          onClose={hideConfirm}
          onConfirm={confirmModal.onConfirm}
          title={confirmModal.title}
          message={confirmModal.message}
          confirmText={confirmModal.confirmText}
          cancelText={confirmModal.cancelText}
          type={confirmModal.type}
        />
      )}
    </div>
  );
}

// Keep existing MetadataDisplay, MaintenanceTab, and SettingsTab components unchanged

function MetadataDisplay({ metadata, groupInfo, onEdit }) {
  const meta = metadata || {};
  
  return (
    <div className="bg-white rounded-xl shadow-sm p-8 space-y-8">
      <div className="flex items-start justify-between">
        <div className="space-y-2 flex-1">
          <h1 className="text-3xl font-bold text-gray-900 leading-tight">
            {meta.title || 'Untitled'}
          </h1>
          {meta.subtitle && (
            <p className="text-lg text-gray-600">{meta.subtitle}</p>
          )}
        </div>
        {onEdit && (
          <button
            onClick={onEdit}
            className="ml-4 px-4 py-2 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg transition-colors font-medium flex items-center gap-2"
          >
            <Edit className="w-4 h-4" />
            Edit
          </button>
        )}
      </div>
      <div className="flex items-center gap-6 text-sm pb-6 border-b border-gray-100">
        <div>
          <span className="text-gray-500">by </span>
          <span className="font-medium text-gray-900">{meta.author || 'Unknown Author'}</span>
        </div>
        {meta.year && (
          <div className="text-gray-500">
            {meta.year}
          </div>
        )}
        {groupInfo && (
          <div className="text-gray-500">
            {groupInfo.files.length} files
          </div>
        )}
      </div>

      {meta.series && (
        <div className="space-y-2">
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Series
          </div>
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-gray-50 rounded-lg border border-gray-200">
            <Book className="w-4 h-4 text-gray-600" />
            <span className="font-medium text-gray-900">{meta.series}</span>
            {meta.sequence && (
              <span className="text-gray-600">#{meta.sequence}</span>
            )}
          </div>
        </div>
      )}

      {meta.narrator && (
        <div className="space-y-2">
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Narrated by
          </div>
          <p className="text-gray-900">{meta.narrator}</p>
        </div>
      )}

      {meta.genres && meta.genres.length > 0 && (
        <div className="space-y-3">
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Genres
          </div>
          <div className="flex flex-wrap gap-2">
            {meta.genres.map((genre, idx) => (
              <span 
                key={idx}
                className="inline-flex items-center px-3 py-1.5 bg-gray-900 text-white text-sm font-medium rounded-full"
              >
                {genre}
              </span>
            ))}
          </div>
        </div>
      )}

      {meta.description && (
        <div className="space-y-3">
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            About
          </div>
          <p className="text-gray-700 leading-relaxed text-sm">
            {meta.description}
          </p>
        </div>
      )}

      {(meta.publisher || meta.isbn) && (
        <div className="pt-6 border-t border-gray-100">
          <div className="grid grid-cols-2 gap-6 text-sm">
            {meta.publisher && (
              <div>
                <div className="text-xs text-gray-500 mb-1">Publisher</div>
                <div className="text-gray-900">{meta.publisher}</div>
              </div>
            )}
            {meta.isbn && (
              <div>
                <div className="text-xs text-gray-500 mb-1">ISBN</div>
                <div className="text-gray-900 font-mono text-xs">{meta.isbn}</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MaintenanceTab() {
  const [confirmModal, setConfirmModal] = useState(null);

  const showConfirm = (config) => {
    setConfirmModal(config);
  };

  const hideConfirm = () => {
    setConfirmModal(null);
  };

  return (
    <div className="p-6 overflow-y-auto bg-gray-50">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Library Maintenance</h2>
          <p className="text-gray-600">
            Advanced maintenance features for AudiobookShelf and local library management.
          </p>
        </div>

        {/* AudiobookShelf Server Section */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="bg-gradient-to-r from-blue-50 to-indigo-50 px-6 py-4 border-b border-gray-200">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                <Upload className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">AudiobookShelf Server</h3>
                <p className="text-sm text-gray-600">Manage your AudiobookShelf Docker container</p>
              </div>
            </div>
          </div>
          
          <div className="p-6 space-y-3">
            <button 
              onClick={() => showConfirm({
                title: "Restart Docker Container",
                message: "This will temporarily stop the AudiobookShelf server. Any active streams will be interrupted. Continue?",
                confirmText: "Restart",
                type: "warning",
                onConfirm: async () => {
                  try {
                    await invoke('restart_abs_docker');
                    alert('✅ Container restarted successfully!');
                  } catch (error) {
                    alert('❌ Failed to restart: ' + error);
                  }
                }
              })}
              className="w-full flex items-center justify-between px-4 py-3 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors group"
            >
              <div className="flex items-center gap-3">
                <RefreshCw className="w-5 h-5 text-blue-600" />
                <div className="text-left">
                  <div className="font-medium text-gray-900">Restart Docker Container</div>
                  <div className="text-sm text-gray-600">Restart the AudiobookShelf service</div>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-blue-600 transition-colors" />
            </button>
            
            <button 
              onClick={() => showConfirm({
                title: "Force Library Rescan",
                message: "This will scan all library folders for changes. Large libraries may take several minutes to complete. Continue?",
                confirmText: "Start Rescan",
                type: "info",
                onConfirm: async () => {
                  try {
                    await invoke('force_abs_rescan');
                    alert('✅ Library rescan triggered!');
                  } catch (error) {
                    alert('❌ Failed to trigger rescan: ' + error);
                  }
                }
              })}
              className="w-full flex items-center justify-between px-4 py-3 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors group"
            >
              <div className="flex items-center gap-3">
                <Book className="w-5 h-5 text-blue-600" />
                <div className="text-left">
                  <div className="font-medium text-gray-900">Force Library Rescan</div>
                  <div className="text-sm text-gray-600">Refresh all books in AudiobookShelf</div>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-blue-600 transition-colors" />
            </button>
            
            <button 
              onClick={() => showConfirm({
                title: "Clear Server Cache",
                message: "This will remove cached images, metadata, and temporary files to free up disk space. Continue?",
                confirmText: "Clear Cache",
                type: "warning",
                onConfirm: async () => {
                  try {
                    await invoke('clear_abs_cache');
                    alert('✅ Server cache cleared!');
                  } catch (error) {
                    alert('❌ Failed to clear cache: ' + error);
                  }
                }
              })}
              className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-lg transition-colors group"
            >
              <div className="flex items-center gap-3">
                <Wrench className="w-5 h-5 text-gray-600" />
                <div className="text-left">
                  <div className="font-medium text-gray-900">Clear Server Cache</div>
                  <div className="text-sm text-gray-600">Remove cached images and metadata</div>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-gray-600 transition-colors" />
            </button>
          </div>
        </div>

        {/* Genre Management Section */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="bg-gradient-to-r from-purple-50 to-pink-50 px-6 py-4 border-b border-gray-200">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-purple-100 rounded-lg">
                <Folder className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Genre Management</h3>
                <p className="text-sm text-gray-600">Clean up and normalize genre tags</p>
              </div>
            </div>
          </div>
          
          <div className="p-6 space-y-3">
            <button 
              onClick={() => showConfirm({
                title: "Clear Unused Genres",
                message: "This will remove genre entries from the dropdown that aren't assigned to any books. This cannot be undone. Continue?",
                confirmText: "Clear Genres",
                type: "danger",
                onConfirm: async () => {
                  try {
                    const result = await invoke('clear_all_genres');
                    alert('✅ ' + result);
                  } catch (error) {
                    alert('❌ Failed: ' + error);
                  }
                }
              })}
              className="w-full flex items-center justify-between px-4 py-3 bg-yellow-50 hover:bg-yellow-100 border border-yellow-200 rounded-lg transition-colors group"
            >
              <div className="flex items-center gap-3">
                <AlertCircle className="w-5 h-5 text-yellow-600" />
                <div className="text-left">
                  <div className="font-medium text-gray-900">Clear Unused Genres</div>
                  <div className="text-sm text-gray-600">Remove genres not assigned to any books</div>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-yellow-600 transition-colors" />
            </button>
            
            <button 
              onClick={() => showConfirm({
                title: "Normalize Book Genres",
                message: "This will update all book genres to match the approved genre list. Some custom genres may be changed or removed. Continue?",
                confirmText: "Normalize Genres",
                type: "warning",
                onConfirm: async () => {
                  try {
                    const result = await invoke('normalize_genres');
                    alert('✅ ' + result);
                  } catch (error) {
                    alert('❌ Failed: ' + error);
                  }
                }
              })}
              className="w-full flex items-center justify-between px-4 py-3 bg-purple-50 hover:bg-purple-100 border border-purple-200 rounded-lg transition-colors group"
            >
              <div className="flex items-center gap-3">
                <Book className="w-5 h-5 text-purple-600" />
                <div className="text-left">
                  <div className="font-medium text-gray-900">Normalize Book Genres</div>
                  <div className="text-sm text-gray-600">Map all genres to approved list</div>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-purple-600 transition-colors" />
            </button>
          </div>
        </div>

        {/* Local Library Section */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="bg-gradient-to-r from-green-50 to-emerald-50 px-6 py-4 border-b border-gray-200">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-100 rounded-lg">
                <FileAudio className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Local Library</h3>
                <p className="text-sm text-gray-600">Manage local metadata cache</p>
              </div>
            </div>
          </div>
          
          <div className="p-6 space-y-3">
            <button 
              onClick={() => showConfirm({
                title: "Clear Metadata Cache",
                message: "This will force the next scan to fetch fresh metadata from APIs instead of using cached data. Continue?",
                confirmText: "Clear Cache",
                type: "danger",
                onConfirm: async () => {
                  try {
                    await invoke('clear_cache');
                    alert('✅ Metadata cache cleared!');
                  } catch (error) {
                    alert('❌ Failed to clear cache: ' + error);
                  }
                }
              })}
              className="w-full flex items-center justify-between px-4 py-3 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg transition-colors group"
            >
              <div className="flex items-center gap-3">
                <AlertCircle className="w-5 h-5 text-red-600" />
                <div className="text-left">
                  <div className="font-medium text-gray-900">Clear Metadata Cache</div>
                  <div className="text-sm text-gray-600">Force fresh API lookups on next scan</div>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-red-600 transition-colors" />
            </button>
          </div>
        </div>

        {/* Info Banner */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0" />
          <div className="text-sm text-blue-900">
            <p className="font-medium mb-1">Maintenance Tips</p>
            <ul className="space-y-1 text-blue-800">
              <li>• Run genre cleanup after bulk tagging operations</li>
              <li>• Clear caches if you experience stale metadata</li>
              <li>• Force rescan after manually organizing files</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Custom Confirmation Modal */}
      {confirmModal && (
        <ConfirmModal
          isOpen={true}
          onClose={hideConfirm}
          onConfirm={confirmModal.onConfirm}
          title={confirmModal.title}
          message={confirmModal.message}
          confirmText={confirmModal.confirmText}
          cancelText={confirmModal.cancelText}
          type={confirmModal.type}
        />
      )}
    </div>
  );
}

function SettingsTab({ config, setConfig, saveConfig, testConnection }) {
  const [confirmModal, setConfirmModal] = useState(null);

  const showConfirm = (config) => {
    setConfirmModal(config);
  };

  const hideConfirm = () => {
    setConfirmModal(null);
  };

  return (
    <div className="p-6 overflow-y-auto bg-gray-50">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Application Settings</h2>
          <p className="text-gray-600">
            Configure connections, API keys, and processing options for optimal performance.
          </p>
        </div>

        {/* AudiobookShelf Connection */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="bg-gradient-to-r from-blue-50 to-indigo-50 px-6 py-4 border-b border-gray-200">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                <Upload className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">AudiobookShelf Connection</h3>
                <p className="text-sm text-gray-600">Connect to your AudiobookShelf server</p>
              </div>
            </div>
          </div>
          
          <div className="p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Base URL
              </label>
              <input
                type="text"
                value={config.abs_base_url}
                onChange={(e) => setConfig({ ...config, abs_base_url: e.target.value })}
                placeholder="http://localhost:13378"
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
              />
              <p className="text-xs text-gray-500 mt-1">URL where your AudiobookShelf server is running</p>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                API Token
              </label>
              <input
                type="password"
                value={config.abs_api_token}
                onChange={(e) => setConfig({ ...config, abs_api_token: e.target.value })}
                placeholder="Enter your API token"
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors font-mono text-sm"
              />
              <p className="text-xs text-gray-500 mt-1">Found in AudiobookShelf Settings → Users → API Tokens</p>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Library ID
              </label>
              <input
                type="text"
                value={config.abs_library_id}
                onChange={(e) => setConfig({ ...config, abs_library_id: e.target.value })}
                placeholder="lib_xxxxxxxxxxxxx"
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors font-mono text-sm"
              />
              <p className="text-xs text-gray-500 mt-1">Library ID from AudiobookShelf URL when viewing your library</p>
            </div>
            
            <div className="flex gap-3 pt-2">
              <button 
                onClick={testConnection} 
                className="px-4 py-2 bg-blue-50 text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors font-medium"
              >
                Test Connection
              </button>
              <button 
                onClick={() => saveConfig(config)} 
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
              >
                Save Settings
              </button>
            </div>
          </div>
        </div>

        {/* API Keys */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="bg-gradient-to-r from-purple-50 to-pink-50 px-6 py-4 border-b border-gray-200">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-purple-100 rounded-lg">
                <Settings className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">API Keys</h3>
                <p className="text-sm text-gray-600">External service credentials for metadata enrichment</p>
              </div>
            </div>
          </div>
          
          <div className="p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                OpenAI API Key
              </label>
              <input
                type="password"
                value={config.openai_api_key || ''}
                onChange={(e) => setConfig({ ...config, openai_api_key: e.target.value })}
                placeholder="sk-..."
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 transition-colors font-mono text-sm"
              />
              <p className="text-xs text-gray-500 mt-1">
                Required for AI-powered metadata extraction and narrator detection
              </p>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Google Books API Key
              </label>
              <input
                type="password"
                value={config.google_books_api_key || ''}
                onChange={(e) => setConfig({ ...config, google_books_api_key: e.target.value })}
                placeholder="AIza..."
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 transition-colors font-mono text-sm"
              />
              <p className="text-xs text-gray-500 mt-1">
                Optional - for high-volume metadata enrichment (prevents rate limiting)
              </p>
            </div>
            
            <div className="pt-2">
              <button 
                onClick={() => saveConfig(config)} 
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-medium"
              >
                Save Settings
              </button>
            </div>
          </div>
        </div>

        {/* Audible Integration */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="bg-gradient-to-r from-orange-50 to-red-50 px-6 py-4 border-b border-gray-200">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-orange-100 rounded-lg">
                <FileAudio className="w-5 h-5 text-orange-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Audible Integration</h3>
                <p className="text-sm text-gray-600">Primary source for audiobook metadata and narrator info</p>
              </div>
            </div>
          </div>
          
          <div className="p-6 space-y-4">
            <div className="flex items-center gap-3 p-4 bg-orange-50 rounded-lg border border-orange-200">
              <input 
                id="audible-enabled"
                type="checkbox" 
                checked={config.audible_enabled || false} 
                onChange={(e) => setConfig({ ...config, audible_enabled: e.target.checked })}
                className="w-5 h-5 text-orange-600 border-gray-300 rounded focus:ring-orange-500" 
              />
              <label htmlFor="audible-enabled" className="flex-1">
                <div className="font-medium text-gray-900">Enable Audible Integration</div>
                <div className="text-sm text-gray-600">Use Audible as primary metadata source (requires audible-cli)</div>
              </label>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Audible CLI Path
              </label>
              <input
                type="text"
                value={config.audible_cli_path || 'audible'}
                onChange={(e) => setConfig({ ...config, audible_cli_path: e.target.value })}
                placeholder="audible"
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 transition-colors font-mono text-sm"
              />
              <div className="mt-2 text-xs text-green-700 bg-green-50 px-3 py-2 rounded border border-green-200">
                ✅ Setup: Run <code className="bg-green-100 px-1 rounded">pip install audible-cli</code> then <code className="bg-green-100 px-1 rounded">audible quickstart</code>
              </div>
            </div>
            
            <div className="pt-2">
              <button 
                onClick={() => saveConfig(config)} 
                className="px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition-colors font-medium"
              >
                Save Settings
              </button>
            </div>
          </div>
        </div>

        {/* Processing Options */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="bg-gradient-to-r from-green-50 to-emerald-50 px-6 py-4 border-b border-gray-200">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-100 rounded-lg">
                <Zap className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Processing Options</h3>
                <p className="text-sm text-gray-600">Performance and behavior settings</p>
              </div>
            </div>
          </div>
          
          <div className="p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Parallel Workers
              </label>
              <input
                type="number"
                min="1"
                max="50"
                value={config.max_workers || 10}
                onChange={(e) => setConfig({ ...config, max_workers: parseInt(e.target.value) })}
                className="w-32 px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 transition-colors"
              />
              <p className="text-xs text-gray-500 mt-1">
                Higher values = faster scanning. Recommended: 20-30 for M4 Mac, 10-15 for older hardware
              </p>
            </div>
            
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-lg border border-gray-200">
                <input 
                  id="skip-unchanged"
                  type="checkbox" 
                  checked={config.skip_unchanged || false} 
                  onChange={(e) => setConfig({ ...config, skip_unchanged: e.target.checked })}
                  className="w-5 h-5 text-green-600 border-gray-300 rounded focus:ring-green-500" 
                />
                <label htmlFor="skip-unchanged" className="flex-1">
                  <div className="font-medium text-gray-900">Skip Unchanged Files</div>
                  <div className="text-sm text-gray-600">Only process files with missing or incorrect metadata</div>
                </label>
              </div>

              <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-lg border border-gray-200">
                <input 
                  id="backup-tags"
                  type="checkbox" 
                  checked={config.backup_tags} 
                  onChange={(e) => setConfig({ ...config, backup_tags: e.target.checked })}
                  className="w-5 h-5 text-green-600 border-gray-300 rounded focus:ring-green-500" 
                />
                <label htmlFor="backup-tags" className="flex-1">
                  <div className="font-medium text-gray-900">Backup Original Tags</div>
                  <div className="text-sm text-gray-600">Create .backup files before modifying metadata</div>
                </label>
              </div>

              <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-lg border border-gray-200">
                <input 
                  id="genre-enforcement"
                  type="checkbox" 
                  checked={config.genre_enforcement} 
                  onChange={(e) => setConfig({ ...config, genre_enforcement: e.target.checked })}
                  className="w-5 h-5 text-green-600 border-gray-300 rounded focus:ring-green-500" 
                />
                <label htmlFor="genre-enforcement" className="flex-1">
                  <div className="font-medium text-gray-900">Enforce Approved Genres</div>
                  <div className="text-sm text-gray-600">Map all genres to a curated list of standard categories</div>
                </label>
              </div>
            </div>

            <div className="pt-2">
              <button 
                onClick={() => saveConfig(config)} 
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium"
              >
                Save Settings
              </button>
            </div>
          </div>
        </div>

        {/* Performance Tips */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0" />
          <div className="text-sm text-blue-900">
            <p className="font-medium mb-1">Performance Tips</p>
            <ul className="space-y-1 text-blue-800">
              <li>• Enable Audible for the most accurate metadata</li>
              <li>• Increase parallel workers on powerful machines</li>
              <li>• Use "Skip Unchanged" for faster rescans</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Custom Confirmation Modal */}
      {confirmModal && (
        <ConfirmModal
          isOpen={true}
          onClose={hideConfirm}
          onConfirm={confirmModal.onConfirm}
          title={confirmModal.title}
          message={confirmModal.message}
          confirmText={confirmModal.confirmText}
          cancelText={confirmModal.cancelText}
          type={confirmModal.type}
        />
      )}
    </div>
  );
}
export default App;