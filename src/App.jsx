import { useState, useEffect, useCallback } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import { ToastProvider } from './components/Toast';
import { ScannerPage } from './pages/ScannerPage';
import { SettingsPage } from './pages/SettingsPage';
import { GlobalProgressBar } from './components/GlobalProgressBar';
import { FileBrowser } from './components/FileBrowser';
import { ErrorBoundary } from './components/ErrorBoundary';
import { closeEventSource } from './api';
import { WelcomeModal, SetupWizard, hasCompletedOnboarding } from './components/OnboardingWizard';
import logoSvg from './assets/logo.svg';

const VALID_TABS = ['scanner', 'settings'];

function getTabFromHash() {
  const hash = window.location.hash.replace('#', '');
  return VALID_TABS.includes(hash) ? hash : 'scanner';
}

function AppContent() {
  const { isLoadingConfig, config } = useApp();
  const [activeTab, setActiveTab] = useState(getTabFromHash);
  const [showFileBrowser, setShowFileBrowser] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [showWizard, setShowWizard] = useState(false);

  // Show welcome modal on first visit (after config loads)
  useEffect(() => {
    if (!isLoadingConfig && !hasCompletedOnboarding()) {
      setShowWelcome(true);
    }
  }, [isLoadingConfig]);

  useEffect(() => {
    const onHashChange = () => setActiveTab(getTabFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    const handleOpen = () => setShowFileBrowser(true);
    window.addEventListener('open-file-browser', handleOpen);
    return () => window.removeEventListener('open-file-browser', handleOpen);
  }, []);

  useEffect(() => {
    return () => closeEventSource();
  }, []);

  const navigateTo = useCallback((tab) => {
    window.location.hash = tab;
    setActiveTab(tab);
  }, []);

  const navigateToSettings = () => navigateTo('settings');

  return (
    <div className="h-screen flex flex-col bg-neutral-950">
      <main className="flex-1 overflow-hidden">
        {isLoadingConfig ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-gray-500 text-sm">Loading...</div>
          </div>
        ) : (
          <>
            {activeTab === 'scanner' && (
              <ScannerPage
                onNavigateToSettings={navigateToSettings}
                activeTab={activeTab}
                navigateTo={navigateTo}
                logoSvg={logoSvg}
              />
            )}
            {activeTab === 'settings' && (
              <SettingsPage
                activeTab={activeTab}
                navigateTo={navigateTo}
                logoSvg={logoSvg}
                onOpenWizard={() => setShowWizard(true)}
              />
            )}
          </>
        )}
      </main>

      <GlobalProgressBar />

      {showFileBrowser && (
        <FileBrowser onClose={() => setShowFileBrowser(false)} />
      )}

      {showWelcome && !showWizard && (
        <WelcomeModal
          onDismiss={() => {
            setShowWelcome(false);
            navigateTo('settings');
          }}
          onStartWizard={() => {
            setShowWelcome(false);
            setShowWizard(true);
          }}
        />
      )}

      {showWizard && (
        <SetupWizard onClose={() => setShowWizard(false)} />
      )}
    </div>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <AppProvider>
        <ToastProvider>
          <AppContent />
        </ToastProvider>
      </AppProvider>
    </ErrorBoundary>
  );
}

export default App;
