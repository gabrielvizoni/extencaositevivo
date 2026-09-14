/* =============================================================================
 * Service worker da automação Info2B.
 * Guarda o status geral e responde ao content script (identificação da aba).
 * ========================================================================== */

let automationStatus = {
  isRunning: false,
  startTime: null,
  config: {
    refreshInterval: 1000,
    validationTimeout: 8000,
    requireStatus: false
  },
  activeTabId: null
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message && message.action) {
    // Usado pelo content script para saber em qual aba/frame está rodando
    // (garante que apenas uma aba assuma o controle da automação).
    case 'whoami':
      sendResponse({
        tabId: sender && sender.tab ? sender.tab.id : null,
        frameId: sender ? sender.frameId : null
      });
      return true;

    case 'startAutomation':
      startAutomation(message.config, message.tabId);
      sendResponse({ success: true });
      return true;

    case 'stopAutomation':
      stopAutomation();
      sendResponse({ success: true });
      return true;

    case 'getStatus':
      sendResponse(automationStatus);
      return true;

    case 'updateConfig':
      updateConfig(message.config);
      sendResponse({ success: true });
      return true;
  }

  sendResponse({ success: true });
  return true;
});

function startAutomation(config, tabId) {
  automationStatus.isRunning = true;
  automationStatus.startTime = Date.now();
  if (config) automationStatus.config = config;
  automationStatus.activeTabId = tabId != null ? tabId : automationStatus.activeTabId;

  if (automationStatus.activeTabId != null) {
    chrome.tabs.sendMessage(
      automationStatus.activeTabId,
      { action: 'startAutomation', config: automationStatus.config },
      () => void chrome.runtime.lastError
    );
  }
}

function stopAutomation() {
  if (automationStatus.isRunning && automationStatus.activeTabId != null) {
    chrome.tabs.sendMessage(
      automationStatus.activeTabId,
      { action: 'stopAutomation' },
      () => void chrome.runtime.lastError
    );
  }
  automationStatus.isRunning = false;
  automationStatus.startTime = null;
}

function updateConfig(config) {
  if (!config) return;
  automationStatus.config = config;

  if (automationStatus.isRunning && automationStatus.activeTabId != null) {
    chrome.tabs.sendMessage(
      automationStatus.activeTabId,
      { action: 'updateConfig', config: config },
      () => void chrome.runtime.lastError
    );
  }
}

// Se a aba controladora for fechada, libera a trava de "dono" da automação.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (automationStatus.activeTabId === tabId) {
    automationStatus.isRunning = false;
    automationStatus.activeTabId = null;
  }
  chrome.storage.local.get(['info2bDono'], (r) => {
    const dono = r && r.info2bDono;
    if (dono && dono.tabId === tabId) chrome.storage.local.remove('info2bDono');
  });
});
