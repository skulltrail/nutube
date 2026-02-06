function showError(message) {
  const el = document.getElementById('error');
  if (el) el.textContent = message;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

document.getElementById('open-dashboard')?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  window.close();
});

document.getElementById('open-youtube')?.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.youtube.com' });
  window.close();
});

document.getElementById('open-options')?.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

document.getElementById('open-side-panel')?.addEventListener('click', async () => {
  try {
    const tab = await getActiveTab();
    if (!tab?.id) {
      showError('No active tab found.');
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: 'OPEN_SIDE_PANEL',
      tabId: tab.id,
    });
    if (!response?.success) {
      showError(response?.error || 'Side panel could not be opened on this tab.');
      return;
    }
    window.close();
  } catch (error) {
    showError('Side panel could not be opened on this tab.');
  }
});
