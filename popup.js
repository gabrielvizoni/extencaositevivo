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
  const intervaloAtivo = document.getElementById('intervalo-ativo');
  const cadenciaMedida = document.getElementById('cadencia-medida');

  const PADROES = { refreshInterval: 1000, validationTimeout: 8000, requireStatus: false };
  const CHAVES = ['refreshInterval', 'validationTimeout', 'requireStatus'];

  // valores realmente gravados (para restaurar o campo em caso de erro)
  const salvo = Object.assign({}, PADROES);
  // campos que o usuário já editou não podem ser sobrescritos pela leitura assíncrona
  const tocados = Object.create(null);
  [refreshInterval, validationTimeout, requireStatus].forEach(function (campo) {
    ['input', 'change'].forEach(function (evento) {
      campo.addEventListener(evento, function () { tocados[campo.id] = true; });
    });
  });

  /**
   * Lê um campo numérico. Em <input type="number"> um conteúdo inválido faz o
   * navegador devolver "" — nesse caso NÃO se assume o padrão silenciosamente:
   * o valor é recusado e o usuário é avisado.
   */
  function lerNumero(campo, minimo, maximo) {
    if (campo.validity && campo.validity.badInput) return { erro: 'inválido' };
    const bruto = String(campo.value).trim();
    if (bruto === '') return { erro: 'vazio' };
    const n = parseInt(bruto, 10);
    if (isNaN(n)) return { erro: 'inválido' };
    if (n < minimo) return { valor: minimo, ajustado: true };
    if (n > maximo) return { valor: maximo, ajustado: true };
    return { valor: n };
  }

  function lerConfigDoFormulario() {
    const intervalo = lerNumero(refreshInterval, 200, 60000);
    const limite = lerNumero(validationTimeout, 1000, 60000);
    if (intervalo.erro) return { erro: 'Intervalo de atualização ' + intervalo.erro };
    if (limite.erro) return { erro: 'Tempo limite ' + limite.erro };
    return {
      config: {
        refreshInterval: intervalo.valor,
        validationTimeout: limite.valor,
        requireStatus: !!requireStatus.checked
      },
      ajustado: !!(intervalo.ajustado || limite.ajustado)
    };
  }

  function aplicarNosCampos(valores) {
    if (!valores) return;
    Object.keys(valores).forEach(function (k) { salvo[k] = valores[k]; });
    if (!tocados['refresh-interval'] && valores.refreshInterval != null) refreshInterval.value = valores.refreshInterval;
    if (!tocados['validation-timeout'] && valores.validationTimeout != null) validationTimeout.value = valores.validationTimeout;
    if (!tocados['require-status'] && valores.requireStatus != null) requireStatus.checked = !!valores.requireStatus;
  }

  /** Grava em local (sem cota, sempre disponível) e espelha em sync. */
  function gravarConfig(config, aoTerminar) {
    chrome.storage.local.set(config, function () {
      const falhaLocal = chrome.runtime.lastError;
      chrome.storage.sync.set(config, function () {
        void chrome.runtime.lastError;   // sync pode falhar (cota/sem conta): local é a fonte
        // confirma lendo de volta o que ficou gravado
        chrome.storage.local.get(CHAVES, function (r) {
          aoTerminar(falhaLocal ? falhaLocal.message : null, r || {});
        });
      });
    });
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
    intervaloAtivo.textContent = d.intervaloAtivo != null ? d.intervaloAtivo + ' ms' : '—';
    cadenciaMedida.textContent = d.periodoMedido != null ? d.periodoMedido + ' ms' : '—';
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

  // Carrega configurações salvas (local é a fonte; sync serve de reserva)
  chrome.storage.sync.get(CHAVES.concat(['isRunning']), function (rSync) {
    void chrome.runtime.lastError;
    chrome.storage.local.get(CHAVES, function (rLocal) {
      const valores = {};
      CHAVES.forEach(function (k) {
        const v = (rLocal && rLocal[k] != null) ? rLocal[k] : ((rSync && rSync[k] != null) ? rSync[k] : PADROES[k]);
        valores[k] = v;
      });
      aplicarNosCampos(valores);
      pintarStatus(rSync && rSync.isRunning);
    });
  });

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
    if (area === 'local') {
      const valores = {};
      CHAVES.forEach(function (k) { if (mudancas[k]) valores[k] = mudancas[k].newValue; });
      if (Object.keys(valores).length) aplicarNosCampos(valores);
    }
  });

  // Iniciar automação
  startBtn.addEventListener('click', function () {
    const leitura = lerConfigDoFormulario();
    if (leitura.erro) {
      avisar(startBtn, 'Iniciar Automação', leitura.erro + '!');
      return;
    }
    gravarConfig(leitura.config, function (falha, gravado) {
      aplicarNosCampos(gravado);
      enviarParaAba({ action: 'startAutomation', config: leitura.config });
      pintarStatus(true);
    });
  });

  // Parar automação
  stopBtn.addEventListener('click', function () {
    enviarParaAba({ action: 'stopAutomation' });
    chrome.storage.sync.set({ isRunning: false });
    pintarStatus(false);
  });

  // Salvar configurações (aplica na hora, sem precisar reiniciar a automação)
  saveSettings.addEventListener('click', function () {
    const leitura = lerConfigDoFormulario();

    if (leitura.erro) {
      // não troca o valor digitado por um padrão: devolve o último valor salvo
      refreshInterval.value = salvo.refreshInterval;
      validationTimeout.value = salvo.validationTimeout;
      avisar(saveSettings, 'Salvar Configurações', leitura.erro + ' — não salvo');
      return;
    }

    gravarConfig(leitura.config, function (falha, gravado) {
      tocados['refresh-interval'] = false;
      tocados['validation-timeout'] = false;
      tocados['require-status'] = false;
      aplicarNosCampos(gravado);
      enviarParaAba({ action: 'updateConfig', config: leitura.config });

      if (falha) avisar(saveSettings, 'Salvar Configurações', 'Falha ao salvar: ' + falha);
      else avisar(saveSettings, 'Salvar Configurações',
        'Salvo: ' + (gravado.refreshInterval != null ? gravado.refreshInterval : leitura.config.refreshInterval) + ' ms');
    });
  });

  function avisar(botao, textoOriginal, mensagem) {
    botao.textContent = mensagem;
    setTimeout(function () { botao.textContent = textoOriginal; }, 2000);
  }

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
