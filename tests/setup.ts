// Chrome API mocks for testing
// These mocks simulate the Chrome Extension APIs used by NuTube

import { vi } from 'vitest';

// Mock chrome.cookies API
const mockCookies = {
  getAll: vi.fn((details, callback) => {
    callback([
      { name: 'SAPISID', value: 'mock-sapisid-value' },
      { name: '__Secure-3PAPISID', value: 'mock-secure-sapisid' },
    ]);
  }),
};

// Mock chrome.tabs API
const mockTabs = {
  query: vi.fn(),
  create: vi.fn(),
  sendMessage: vi.fn(),
  onUpdated: {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  },
};

// Mock chrome.runtime API
const mockRuntime = {
  onMessage: {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  },
  getURL: vi.fn((path: string) => `chrome-extension://mock-id/${path}`),
};

// Mock chrome.action API
const mockAction = {
  onClicked: {
    addListener: vi.fn(),
  },
};

// Mock chrome.scripting API
const mockScripting = {
  executeScript: vi.fn(),
};

// Mock chrome.storage API
const mockStorage = {
  local: {
    get: vi.fn(),
    set: vi.fn(),
  },
  sync: {
    get: vi.fn(),
    set: vi.fn(),
  },
};

// Assemble the mock chrome object
const mockChrome = {
  cookies: mockCookies,
  tabs: mockTabs,
  runtime: mockRuntime,
  action: mockAction,
  scripting: mockScripting,
  storage: mockStorage,
};

// Set up global chrome object
(globalThis as any).chrome = mockChrome;

// Mock crypto.subtle for SAPISIDHASH generation
if (!globalThis.crypto?.subtle) {
  const mockSubtle = {
    digest: vi.fn(async (algorithm: string, data: ArrayBuffer) => {
      // Return a mock SHA-1 hash (20 bytes)
      return new Uint8Array(20).fill(0xab).buffer;
    }),
  };

  (globalThis as any).crypto = {
    subtle: mockSubtle,
  };
}

// Mock TextEncoder if not available
if (!globalThis.TextEncoder) {
  (globalThis as any).TextEncoder = class TextEncoder {
    encode(str: string): Uint8Array {
      return new Uint8Array(Buffer.from(str, 'utf-8'));
    }
  };
}

// Export mocks for use in tests
export { mockChrome, mockCookies, mockTabs, mockRuntime, mockAction, mockScripting, mockStorage };
