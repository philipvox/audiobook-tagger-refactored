import { useState, useEffect, useCallback } from 'react';
import { Library, Wrench, Settings, Sparkles, Users } from 'lucide-react';
import { AppProvider, useApp } from './context/AppContext';
import { ToastProvider } from './components/Toast';
import { ScannerPage } from './pages/ScannerPage';
import { MaintenancePage } from './pages/MaintenancePage';
import { SettingsPage } from './pages/SettingsPage';
import { ImmersionSyncPage } from './pages/ImmersionSyncPage';
import { AuthorsPage } from './pages/AuthorsPage';
import { GlobalProgressBar } from './components/GlobalProgressBar';
import logoSvg from './assets/logo.svg';

const VALID_TABS = ['scanner', 'authors', 'maintenance', 'settings', 'immersion'];

function getTabFromHash() {
  const hash = window.location.hash.replace('#', '');
  return VALID_TABS.includes(hash) ? hash : 'scanner';
}

function AppContent() {
  const { isLoadingConfig } = useApp();
  const [activeTab, setActiveTab] = useState(getTabFromHash);

  // Sync tab state with URL hash
  useEffect(() => {
    const onHashChange = () => setActiveTab(getTabFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigateTo = useCallback((tab) => {
    window.location.hash = tab;
    setActiveTab(tab);
  }, []);

  // Navigation callback for child components
  const navigateToSettings = () => navigateTo('settings');

  const tabs = [
    { id: 'scanner', label: 'Library', icon: Library },
    { id: 'authors', label: 'Authors', icon: Users },
    { id: 'maintenance', label: 'Maintenance', icon: Wrench, hidden: true },
    { id: 'settings', label: 'Settings', icon: Settings },
    { id: 'immersion', label: 'Sync', icon: Sparkles, hidden: true },
  ];

  return (
    <div className="h-screen flex flex-col bg-neutral-950">
      {/* Header */}
      <header className="bg-neutral-950 px-5 py-4">
        <div className="flex items-center gap-6">
          {/* Logo */}
          <img src={logoSvg} alt="Secret Library" style={{ height: '32px' }} className="invert opacity-90" />

          {/* Navigation Pills */}
          <nav className="flex items-center gap-1 bg-neutral-900/50 rounded-full p-1">
            {tabs.filter(t => !t.hidden).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => navigateTo(id)}
                className={`px-4 py-2 text-sm font-medium rounded-full transition-all flex items-center gap-2 ${
                  activeTab === id
                    ? 'bg-neutral-800 text-white'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-hidden">
        {isLoadingConfig ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-gray-500 text-sm">Loading configuration...</div>
          </div>
        ) : (
          <>
            {activeTab === 'scanner' && <ScannerPage onNavigateToSettings={navigateToSettings} />}
            {activeTab === 'authors' && <AuthorsPage />}
            {activeTab === 'maintenance' && <MaintenancePage />}
            {activeTab === 'settings' && <SettingsPage />}
            {activeTab === 'immersion' && <ImmersionSyncPage />}
          </>
        )}
      </main>

      {/* Global Progress Bar - Shows for any long-running operation */}
      <GlobalProgressBar />
    </div>
  );
}

function App() {
  return (
    <AppProvider>
      <ToastProvider>
        <AppContent />
      </ToastProvider>
    </AppProvider>
  );
}

export default App;
