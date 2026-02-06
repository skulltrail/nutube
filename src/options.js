const DEFAULT_SETTINGS = {
  defaultTab: 'watchlater',
  operationConcurrency: 4,
  operationRetries: 2,
  fuzzyThreshold: 0.45,
  keymap: {
    delete: 'x',
    move: 'm',
    refresh: 'r',
  },
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function setStatus(message, error = false) {
  const status = document.getElementById('status');
  if (!status) return;
  status.textContent = message;
  status.style.color = error ? '#ff8b8b' : '#a3a3aa';
}

function readForm() {
  const defaultTab = document.getElementById('default-tab').value;
  const operationConcurrency = clamp(parseInt(document.getElementById('operation-concurrency').value || '4', 10), 1, 8);
  const operationRetries = clamp(parseInt(document.getElementById('operation-retries').value || '2', 10), 0, 5);
  const fuzzyThreshold = clamp(parseFloat(document.getElementById('fuzzy-threshold').value || '0.45'), 0.1, 0.95);

  const keymapRaw = document.getElementById('keymap-json').value.trim();
  let keymap = { ...DEFAULT_SETTINGS.keymap };
  if (keymapRaw) {
    const parsed = JSON.parse(keymapRaw);
    if (parsed && typeof parsed === 'object') {
      keymap = {
        ...keymap,
        ...parsed,
      };
    }
  }

  return {
    defaultTab,
    operationConcurrency,
    operationRetries,
    fuzzyThreshold,
    keymap,
  };
}

function applyForm(settings) {
  document.getElementById('default-tab').value = settings.defaultTab;
  document.getElementById('operation-concurrency').value = String(settings.operationConcurrency);
  document.getElementById('operation-retries').value = String(settings.operationRetries);
  document.getElementById('fuzzy-threshold').value = String(settings.fuzzyThreshold);
  document.getElementById('keymap-json').value = JSON.stringify(settings.keymap);
}

async function loadSettings() {
  const result = await chrome.storage.local.get(['nutubeSettings']);
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(result.nutubeSettings || {}),
    keymap: {
      ...DEFAULT_SETTINGS.keymap,
      ...(result.nutubeSettings?.keymap || {}),
    },
  };
  applyForm(settings);
}

async function saveSettings() {
  try {
    const settings = readForm();
    await chrome.storage.local.set({ nutubeSettings: settings });
    setStatus('Saved. Changes apply on next dashboard interaction.');
  } catch (error) {
    setStatus('Invalid JSON in key mapping.', true);
  }
}

async function resetDefaults() {
  applyForm(DEFAULT_SETTINGS);
  await chrome.storage.local.set({ nutubeSettings: DEFAULT_SETTINGS });
  setStatus('Defaults restored.');
}

document.getElementById('save')?.addEventListener('click', saveSettings);
document.getElementById('reset')?.addEventListener('click', resetDefaults);

loadSettings().catch(() => setStatus('Failed to load settings.', true));
