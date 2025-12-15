import { useState } from 'react';
import { FileAudio, RefreshCw, Wrench, Settings, FileSearch, FolderTree, Wand2, Copy, Disc3 } from 'lucide-react';
import { AppProvider } from './context/AppContext';
import { ScannerPage } from './pages/ScannerPage';
import { MaintenancePage } from './pages/MaintenancePage';
import { SettingsPage } from './pages/SettingsPage';
import { FolderFixerPage } from './pages/FolderFixerPage';
import { SmartRenamePage } from './pages/SmartRenamePage';
import { DuplicateFinderPage } from './pages/DuplicateFinderPage';
import { ConvertPage } from './pages/ConvertPage';
import { RawTagInspector } from './components/RawTagInspector';
import { GlobalProgressBar } from './components/GlobalProgressBar';

function AppContent() {
  const [activeTab, setActiveTab] = useState('scanner');
  const [showTagInspector, setShowTagInspector] = useState(false);

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
              onClick={() => setShowTagInspector(true)}
              className="px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium flex items-center gap-2"
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
            onClick={() => setActiveTab('folder-fixer')}
            className={`px-4 py-2 font-medium transition-colors ${
              activeTab === 'folder-fixer'
                ? 'text-red-600 border-b-2 border-red-600'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            <div className="flex items-center gap-2">
              <FolderTree className="w-4 h-4" />
              Folder Fixer
            </div>
          </button>
          <button
            onClick={() => setActiveTab('smart-rename')}
            className={`px-4 py-2 font-medium transition-colors ${
              activeTab === 'smart-rename'
                ? 'text-red-600 border-b-2 border-red-600'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            <div className="flex items-center gap-2">
              <Wand2 className="w-4 h-4" />
              Smart Rename
            </div>
          </button>
          <button
            onClick={() => setActiveTab('duplicates')}
            className={`px-4 py-2 font-medium transition-colors ${
              activeTab === 'duplicates'
                ? 'text-red-600 border-b-2 border-red-600'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            <div className="flex items-center gap-2">
              <Copy className="w-4 h-4" />
              Duplicates
            </div>
          </button>
          <button
            onClick={() => setActiveTab('convert')}
            className={`px-4 py-2 font-medium transition-colors ${
              activeTab === 'convert'
                ? 'text-red-600 border-b-2 border-red-600'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            <div className="flex items-center gap-2">
              <Disc3 className="w-4 h-4" />
              Convert
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
        {activeTab === 'scanner' && <ScannerPage />}
        {activeTab === 'maintenance' && <MaintenancePage />}
        {activeTab === 'folder-fixer' && <FolderFixerPage />}
        {activeTab === 'smart-rename' && <SmartRenamePage />}
        {activeTab === 'duplicates' && <DuplicateFinderPage />}
        {activeTab === 'convert' && <ConvertPage />}
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