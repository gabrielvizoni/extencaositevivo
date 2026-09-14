document.addEventListener('DOMContentLoaded', function () {
  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');
  const statusBadge = document.getElementById('status-badge');
  const refreshInterval = document.getElementById('refresh-interval');
  const validationTimeout = document.getElementById('validation-timeout');
  const requireStatus = document.getElementById('require-status');
  const saveSettings = document.getElementById('save-settings');
  const resetProgress = document.getElementById('reset-progress');

  const estadoAtual = document.getElementById('estado-atual');
  const ultimoCodigo = document.getElementById('ultimo-codigo');
  const totalTransformados = document.getElementById('total-transformados');
  const totalBloqueados = document.getElementById('total-bloqueados');

  const PADROES = { refreshInterval: 1000, validationTimeout: 8000, requireStatus: false };

  function lerConfigDoFormulario() {
    const intervalo = parseInt(refreshInterval.value, 10);
    const limite = parseInt(validationTimeout.value, 10);
    return {
      refreshInterval: isNaN(intervalo) ? PADROES.refreshInterval : Math.min(60000, Math.max(200, intervalo)),
      validationTimeout: isNaN(limite) ? PADROES.validationTimeout : Math.min(60000, Math.max(1000, limite)),
      requireStatus: !!requireStatus.checked
    };
  }

  function pintarStatus(ativo) {
    statusBadge.textContent = ativo ? 'Ativado' : 'Desativado';
    statusBadge.classList.toggle('active', !!ativo);
  }

  function mostrarProgresso(dados) {
    const d = dados || {};
    estadoAtual.textContent = d.fase || '—';
    ultimoCodigo.textContent = d.ultimoCodigo ? d.ultimoCodigo : '—';
    totalTransformados.textContent = (d.transformados || []).length;
    totalBloqueados.textContent = (d.bloqueados || []).length;
  }

  function enviarParaAba(mensagem) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (!tabs || !tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, mensagem, function () {
        // a aba pode não ter o content script (outro site): ignora o erro
        void chrome.runtime.lastError;
      });
    });
  }

  // Carrega configurações salvas
  chrome.storage.sync.get(
    ['refreshInterval', 'validationTimeout', 'requireStatus', 'isRunning'],
    function (result) {
      refreshInterval.value = result.refreshInterval != null ? result.refreshInterval : PADROES.refreshInterval;
      validationTimeout.value = result.validationTimeout != null ? result.validationTimeout : PADROES.validationTimeout;
      requireStatus.checked = !!result.requireStatus;
      pintarStatus(result.isRunning);
    }
  );

  // Carrega o progresso da fila
  chrome.storage.local.get(['info2bProgresso'], function (r) {
    mostrarProgresso(r && r.info2bProgresso);
  });

  // Mantém o painel sincronizado enquanto estiver aberto
  chrome.storage.onChanged.addListener(function (mudancas, area) {
    if (area === 'local' && mudancas.info2bProgresso) {
      mostrarProgresso(mudancas.info2bProgresso.newValue);
    }
    if (area === 'sync' && mudancas.isRunning) {
      pintarStatus(mudancas.isRunning.newValue);
    }
  });

  // Iniciar automação
  startBtn.addEventListener('click', function () {
    const config = lerConfigDoFormulario();
    chrome.storage.sync.set(config);
    enviarParaAba({ action: 'startAutomation', config: config });
    pintarStatus(true);
  });

  // Parar automação
  stopBtn.addEventListener('click', function () {
    enviarParaAba({ action: 'stopAutomation' });
    chrome.storage.sync.set({ isRunning: false });
    pintarStatus(false);
  });

  // Salvar configurações (aplica na hora, sem precisar reiniciar a automação)
  saveSettings.addEventListener('click', function () {
    const config = lerConfigDoFormulario();
    refreshInterval.value = config.refreshInterval;
    validationTimeout.value = config.validationTimeout;

    chrome.storage.sync.set(config);
    enviarParaAba({ action: 'updateConfig', config: config });

    saveSettings.textContent = 'Configurações Salvas!';
    setTimeout(function () {
      saveSettings.textContent = 'Salvar Configurações';
    }, 1500);
  });

  // Zera a progressão (volta a considerar códigos antigos)
  resetProgress.addEventListener('click', function () {
    chrome.storage.local.remove('info2bProgresso');
    enviarParaAba({ action: 'resetProgress' });
    mostrarProgresso(null);

    resetProgress.textContent = 'Progresso zerado!';
    setTimeout(function () {
      resetProgress.textContent = 'Zerar progresso da fila';
    }, 1500);
  });
});
