import { useState } from 'react';
import { FileAudio, RefreshCw, Wrench, Settings, FileSearch } from 'lucide-react';
import { AppProvider } from './context/AppContext';
import { ScannerPage } from './pages/ScannerPage';
import { MaintenancePage } from './pages/MaintenancePage';
import { SettingsPage } from './pages/SettingsPage';
import { RawTagInspector } from './components/RawTagInspector';

function AppContent() {
  const [activeTab, setActiveTab] = useState('scanner');
  const [showTagInspector, setShowTagInspector] = useState(false);
  const [scannerActions, setScannerActions] = useState(null);

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
            <button 
              onClick={() => scannerActions?.handleScan()} 
              disabled={scannerActions?.scanning} 
              className="btn btn-primary flex items-center gap-2"
            >
              <RefreshCw className={`w-4 h-4 ${scannerActions?.scanning ? 'animate-spin' : ''}`} />
              {scannerActions?.scanning ? 'Scanning...' : 'Scan Library'}
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