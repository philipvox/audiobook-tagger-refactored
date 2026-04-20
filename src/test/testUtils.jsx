// src/test/testUtils.jsx
// Test utilities for React component testing

import { render } from '@testing-library/react';
import { vi } from 'vitest';

// Create a mock AppProvider for testing
export const MockAppProvider = ({ children, config = {}, groups = [] }) => {
  const mockContext = {
    config: {
      abs_base_url: 'http://localhost:8000',
      abs_api_token: 'test-token',
      abs_library_id: 'lib_123',
      metadata_concurrency: 10,
      file_scan_concurrency: 5,
      custom_providers: [],
      genre_mappings: {},
      openai_api_key: null,
      ...config,
    },
    setConfig: vi.fn(),
    loadConfig: vi.fn(),
    saveConfig: vi.fn(),
    groups,
    setGroups: vi.fn(),
    fileStatuses: {},
    updateFileStatus: vi.fn(),
    updateFileStatuses: vi.fn(),
    clearFileStatuses: vi.fn(),
    writeProgress: { current: 0, total: 0 },
    setWriteProgress: vi.fn(),
    globalProgress: {
      active: false,
      current: 0,
      total: 0,
      message: '',
      detail: '',
      startTime: null,
      canCancel: false,
      type: 'info',
      cancelFn: null,
    },
    startGlobalProgress: vi.fn(),
    updateGlobalProgress: vi.fn(),
    endGlobalProgress: vi.fn(),
    cancelGlobalProgress: vi.fn(),
  };

  // Import the actual context to use its Provider
  const AppContext = require('../context/AppContext').default;

  return (
    <AppContext.Provider value={mockContext}>
      {children}
    </AppContext.Provider>
  );
};

// Render with providers
export const renderWithProviders = (ui, options = {}) => {
  const { config, groups, ...renderOptions } = options;

  return render(ui, {
    wrapper: ({ children }) => (
      <MockAppProvider config={config} groups={groups}>
        {children}
      </MockAppProvider>
    ),
    ...renderOptions,
  });
};

// Create mock book group
export const createMockBookGroup = (overrides = {}) => ({
  id: `book-${Math.random().toString(36).substr(2, 9)}`,
  group_name: 'Test Book',
  folder_path: '/test/path',
  files: [
    {
      id: 'file-1',
      filename: 'test.m4b',
      path: '/test/path/test.m4b',
      duration: 36000,
      bitrate: 128,
      codec: 'AAC',
      chapter_count: 20,
      size: 500000000,
    },
  ],
  metadata: {
    title: 'Test Book',
    subtitle: null,
    author: 'Test Author',
    authors: ['Test Author'],
    narrator: 'Test Narrator',
    narrators: ['Test Narrator'],
    series: null,
    sequence: null,
    description: 'A test book description.',
    publisher: 'Test Publisher',
    year: '2023',
    genres: ['Fantasy', 'Adventure'],
    language: 'English',
    asin: 'B0TEST',
    cover_url: null,
    ...overrides.metadata,
  },
  scan_status: 'Pending',
  total_changes: 0,
  ...overrides,
});

// Create mock audio file
export const createMockAudioFile = (overrides = {}) => ({
  id: `file-${Math.random().toString(36).substr(2, 9)}`,
  filename: 'audiobook.m4b',
  path: '/test/audiobook.m4b',
  duration: 36000,
  bitrate: 128,
  codec: 'AAC',
  chapter_count: 20,
  size: 500000000,
  ...overrides,
});

// Create mock config
export const createMockConfig = (overrides = {}) => ({
  abs_base_url: 'http://localhost:8000',
  abs_api_token: 'test-token-123',
  abs_library_id: 'lib_abc123',
  library_paths: ['/test/audiobooks'],
  metadata_concurrency: 10,
  file_scan_concurrency: 5,
  cover_concurrency: 5,
  custom_providers: [],
  genre_mappings: {},
  openai_api_key: null,
  default_language: 'English',
  rename_template: '{author}/{series}/{sequence} - {title}',
  skip_hidden_folders: true,
  ...overrides,
});

// Mock Tauri invoke function with common responses
export const createMockInvoke = () => {
  const mockInvoke = vi.fn();

  mockInvoke.mockImplementation(async (cmd, args) => {
    switch (cmd) {
      case 'get_config':
        return createMockConfig();
      case 'save_config':
        return undefined;
      case 'scan_library':
        return { groups: [] };
      case 'get_scan_progress':
        return { current: 0, total: 0, current_file: '' };
      case 'write_tags':
        return { success: true, results: [] };
      case 'import_from_abs':
        return { groups: [], total_imported: 0 };
      default:
        return null;
    }
  });

  return mockInvoke;
};

// Wait for async state updates
export const waitForStateUpdate = () =>
  new Promise((resolve) => setTimeout(resolve, 0));

// Re-export testing library utilities
export * from '@testing-library/react';
export { vi } from 'vitest';
