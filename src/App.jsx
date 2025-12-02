import { useState, useRef, useEffect } from 'react';
import { FileAudio, RefreshCw, Wrench, Settings, FileSearch, ChevronDown, Zap, Sparkles } from 'lucide-react';
import { AppProvider } from './context/AppContext';
import { ScannerPage } from './pages/ScannerPage';
import { MaintenancePage } from './pages/MaintenancePage';
import { SettingsPage } from './pages/SettingsPage';
import { RawTagInspector } from './components/RawTagInspector';
import { GlobalProgressBar } from './components/GlobalProgressBar';

// Scan mode options for the main scan button dropdown
const SCAN_MODES = [
  { id: 'normal', label: 'Smart Scan', description: 'Skip books with existing metadata', icon: Zap },
  { id: 'force_fresh', label: 'Clean Scan', description: 'Clear caches and fetch all fresh data', icon: Sparkles },
];

function AppContent() {
  const [activeTab, setActiveTab] = useState('scanner');
  const [showTagInspector, setShowTagInspector] = useState(false);
  const [scannerActions, setScannerActions] = useState(null);
  const [showScanMenu, setShowScanMenu] = useState(false);
  const scanMenuRef = useRef(null);

  // Close menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (scanMenuRef.current && !scanMenuRef.current.contains(event.target)) {
        setShowScanMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleScanWithMode = (mode) => {
    setShowScanMenu(false);
    scannerActions?.handleScan(mode);
  };

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <FileAudio className="w-8 h-8 text-red-600" />
            <h1 className="text-2xl font-bold text-gray-900">Audiobook Tagger</h1>
          </div>

          <div className="flex items-center gap-4">
            {/* Scan Split Button with Dropdown */}
            <div className="relative" ref={scanMenuRef}>
              <div className="flex">
                <button
                  onClick={() => handleScanWithMode('normal')}
                  disabled={scannerActions?.scanning}
                  className="px-4 py-2 bg-blue-600 text-white rounded-l-lg hover:bg-blue-700 transition-colors font-medium flex items-center gap-2 disabled:opacity-50"
                >
                  <RefreshCw className={`w-4 h-4 ${scannerActions?.scanning ? 'animate-spin' : ''}`} />
                  {scannerActions?.scanning ? 'Scanning...' : 'Scan Library'}
                </button>
                <button
                  onClick={() => setShowScanMenu(!showScanMenu)}
                  disabled={scannerActions?.scanning}
                  className="px-2 py-2 bg-blue-600 text-white rounded-r-lg hover:bg-blue-700 transition-colors border-l border-blue-500 disabled:opacity-50"
                >
                  <ChevronDown className="w-4 h-4" />
                </button>
              </div>

              {/* Dropdown Menu */}
              {showScanMenu && (
                <div className="absolute right-0 mt-1 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
                  <div className="py-1">
                    {SCAN_MODES.map(mode => {
                      const Icon = mode.icon;
                      return (
                        <button
                          key={mode.id}
                          onClick={() => handleScanWithMode(mode.id)}
                          className="w-full px-4 py-3 text-left hover:bg-gray-50 transition-colors flex items-start gap-3"
                        >
                          <Icon className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0" />
                          <div>
                            <div className="font-medium text-gray-900">{mode.label}</div>
                            <div className="text-xs text-gray-500">{mode.description}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

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

      {/* Navigation Tabs */}
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

      {/* Main Content */}
      <main className="flex-1 overflow-hidden">
        {activeTab === 'scanner' && <ScannerPage onActionsReady={setScannerActions} />}
        {activeTab === 'maintenance' && <MaintenancePage />}
        {activeTab === 'settings' && <SettingsPage />}
      </main>

      {/* Tag Inspector Modal */}
      {showTagInspector && (
        <RawTagInspector
          isOpen={showTagInspector}
          onClose={() => setShowTagInspector(false)}
        />
      )}

      {/* Global Progress Bar - Shows for any long-running operation */}
      <GlobalProgressBar />
    </div>
  );
}

function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}

export default App;