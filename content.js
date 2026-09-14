/* =============================================================================
 * Automação Info2B — Pré-pedidos do setor MÓVEL
 * -----------------------------------------------------------------------------
 * Motor de automação baseado em máquina de estados.
 *
 * Regras absolutas (nesta ordem):
 *   1. NUNCA transformar um pedido com status CANCELADO.
 *   2. NUNCA processar um pedido cujo TIPO não seja exatamente "Móvel".
 *   3. NUNCA abrir/processar um pedido diferente do que foi selecionado.
 *   4. NUNCA processar o mesmo código duas vezes.
 *   5. A progressão da fila é controlada pelo número do Info (comparação numérica).
 *
 * Todas as decisões são tomadas a partir da LINHA do pedido (nunca de elementos
 * globais da página) e confirmadas novamente dentro da tela de acompanhamento.
 * ========================================================================== */
(function () {
  'use strict';

  if (window.__INFO2B_AUTOMACAO_ATIVA__) return;
  window.__INFO2B_AUTOMACAO_ATIVA__ = true;

  /* ========================== CONSTANTES ================================== */

  const TAG = '[INFO2B]';
  const VERSAO = '2.0';

  const PADROES = {
    refreshInterval: 1000,    // intervalo mínimo entre atualizações da fila (ms)
    validationTimeout: 8000,  // tempo máximo de espera por elementos/validações (ms)
    requireStatus: false      // true = bloqueia pedidos sem status definido
  };
  const CONFIG = Object.assign({}, PADROES);

  const TIPO_ALVO = 'MOVEL';
  const TIPOS_CONHECIDOS = ['MOVEL', 'FIXO', 'VSTI', 'AVANCADA'];

  // Qualquer status que contenha CANCELAD (CANCELADO/CANCELADA/CANCELADOS...)
  const RE_STATUS_BLOQUEADO = /CANCELAD/;
  // Valores que representam "sem status definido"
  const STATUS_SEM_VALOR = [
    '', '-', '--', 'N/A', 'NAO INFORMADO', 'NAO INFORMADA',
    'SELECIONE', 'SELECIONE UM STATUS', 'SELECIONE UMA OPCAO', 'NENHUM'
  ];

  const ROTA_LISTA = '#!/pre-pedidos';
  const RE_ROTA_ACOMPANHAMENTO = /#!\/pre-pedidos\/acompanhamento\/(\d+)/i;
  const RE_TITULO_ACOMPANHAMENTO = /ACOMPANHAMENTO DO PRE-?PEDIDO\s+(\d+)\s*(?:\(([^)]*)\))?/;

  const MAX_TENTATIVAS_POR_CODIGO = 2;   // falhas antes de bloquear definitivamente
  const MAX_HISTORICO = 200;             // limite de códigos guardados no storage
  const LOCK_TTL = 6000;                 // validade do "dono" da automação (ms)

  // Estados em que é seguro reagir a uma página fora do fluxo
  const ESTADOS_OCIOSOS_NOMES = [
    'IDLE', 'PROCURANDO_PEDIDO', 'VALIDANDO_LINHA', 'ATUALIZANDO_FILA', 'AGUARDANDO_NOVO_CODIGO'
  ];

  const CHAVE_PROGRESSO = 'info2bProgresso';
  const CHAVE_DONO = 'info2bDono';

  // Estados da automação
  const E = {
    IDLE:                   'IDLE',
    AGUARDANDO_PAGINA:      'AGUARDANDO_PAGINA',
    PROCURANDO_PEDIDO:      'PROCURANDO_PEDIDO',
    VALIDANDO_LINHA:        'VALIDANDO_LINHA',
    ABRINDO_ACOMPANHAMENTO: 'ABRINDO_ACOMPANHAMENTO',
    VALIDANDO_PEDIDO:       'VALIDANDO_PEDIDO',
    VALIDANDO_STATUS:       'VALIDANDO_STATUS',
    TRANSFORMANDO:          'TRANSFORMANDO',
    CONFIRMANDO:            'CONFIRMANDO',
    CONCLUIDO:              'CONCLUIDO',
    BLOQUEADO:              'BLOQUEADO',
    RETORNANDO_FILA:        'RETORNANDO_FILA',
    ATUALIZANDO_FILA:       'ATUALIZANDO_FILA',
    AGUARDANDO_NOVO_CODIGO: 'AGUARDANDO_NOVO_CODIGO'
  };

  const ESTADOS_OCIOSOS = ESTADOS_OCIOSOS_NOMES.map((n) => E[n]);

  /* ============================ ESTADO ==================================== */

  const INSTANCIA = 'f' + Math.random().toString(36).slice(2, 10);

  let rodando = false;            // automação ligada
  let motorAtivo = false;         // laço principal em execução (impede concorrência)
  let estado = E.IDLE;
  let alvo = null;                // { codigo, tipo, tentativa, transformarClicado, simClicado }
  let urlDaLista = null;          // última URL conhecida da lista de pré-pedidos
  let ultimaAtualizacao = 0;      // timestamp da última atualização da fila
  let atualizandoFila = false;    // trava: nunca duas atualizações simultâneas
  let navegando = false;          // trava: nunca duas navegações simultâneas
  let esperasSemCodigo = 0;       // ciclos sem nenhum código maior disponível
  let estrategiaAtualizacao = 0;  // estratégia de refresh em uso
  let semMudancaNaGrade = 0;      // atualizações consecutivas sem alteração no DOM
  let notificacao = null;
  let meuTabId = null;
  let ultimoToqueDono = 0;
  let avisoPaginaDado = false;
  let geracaoInicio = 0;          // invalida inícios em andamento quando o usuário para
  let paradaSolicitada = false;

  const progresso = {
    ultimoCodigo: 0,              // maior código já processado OU bloqueado
    transformados: new Set(),
    bloqueados: new Set(),
    tentativas: Object.create(null)
  };

  /* ============================ UTILIDADES ================================ */

  const log  = (...a) => console.log(TAG, ...a);
  const aviso = (...a) => console.warn(TAG, ...a);
  const erro = (...a) => console.error(TAG, ...a);

  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms | 0)));

  /** Normaliza texto: remove acentos, colapsa espaços e coloca em maiúsculas. */
  function normalizar(texto) {
    return String(texto == null ? '' : texto)
      .replace(/\u00a0/g, ' ')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();
  }

  function visivel(el) {
    if (!el || !el.isConnected) return false;
    if (el.disabled) return false;
    if (typeof el.getClientRects === 'function' && el.getClientRects().length > 0) return true;
    // jsdom / elementos sem layout: usa heurística por classes de ocultação
    const cls = el.className && el.className.baseVal != null ? el.className.baseVal : (el.className || '');
    if (/\bng-hide\b|\bhidden\b/.test(String(cls))) return false;
    let n = el;
    while (n && n.nodeType === 1) {
      const st = n.getAttribute && n.getAttribute('style');
      if (st && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(st)) return false;
      if (n.hasAttribute && n.hasAttribute('hidden')) return false;
      const c = String(n.className && n.className.baseVal != null ? n.className.baseVal : (n.className || ''));
      if (/\bng-hide\b/.test(c)) return false;
      n = n.parentElement;
    }
    return true;
  }

  /**
   * Espera até que `predicado()` devolva um valor "verdadeiro".
   * Reage a mudanças reais do DOM (MutationObserver) + polling curto,
   * em vez de usar delays fixos.
   */
  function esperarPor(predicado, opcoes) {
    const op = opcoes || {};
    const limite = op.timeout != null ? op.timeout : CONFIG.validationTimeout;
    const intervalo = op.interval != null ? op.interval : 80;

    return new Promise((resolve) => {
      let concluido = false;
      let observador = null;
      let timerPoll = null;
      let timerLimite = null;

      const encerrar = (valor) => {
        if (concluido) return;
        concluido = true;
        if (observador) observador.disconnect();
        if (timerPoll) clearInterval(timerPoll);
        if (timerLimite) clearTimeout(timerLimite);
        resolve(valor || null);
      };

      const tentar = () => {
        if (concluido) return null;
        let valor = null;
        try { valor = predicado(); } catch (e) { valor = null; }
        if (valor) encerrar(valor);
        return valor;
      };

      if (tentar()) return;

      try {
        observador = new MutationObserver(tentar);
        observador.observe(document.documentElement || document, {
          childList: true, subtree: true, characterData: true
        });
      } catch (e) { /* ambiente sem MutationObserver */ }

      timerPoll = setInterval(tentar, intervalo);
      timerLimite = setTimeout(() => encerrar(null), limite);
    });
  }

  /** Clique compatível com ng-click (tenta .click() e, se preciso, eventos de mouse). */
  function clicar(el) {
    if (!el) return false;
    try { el.click(); return true; } catch (e) { /* segue para eventos */ }
    try {
      ['mousedown', 'mouseup', 'click'].forEach((tipo) => {
        el.dispatchEvent(new MouseEvent(tipo, { bubbles: true, cancelable: true, view: window }));
      });
      return true;
    } catch (e) { return false; }
  }

  function clicarComEventos(el) {
    if (!el) return false;
    try {
      ['mousedown', 'mouseup', 'click'].forEach((tipo) => {
        el.dispatchEvent(new MouseEvent(tipo, { bubbles: true, cancelable: true, view: window }));
      });
      return true;
    } catch (e) { return false; }
  }

  function dispararMudanca(el) {
    if (!el) return;
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
  }

  /* ====================== NOTIFICAÇÃO VISUAL (mantida) ==================== */

  function injetarEstilos() {
    if (!document.head || document.getElementById('info2b-automation-style')) return;
    const style = document.createElement('style');
    style.id = 'info2b-automation-style';
    style.textContent = [
      '#automation-notification{position:fixed;bottom:20px;right:20px;padding:12px 18px;',
      'border-radius:6px;font-family:"Segoe UI",Arial,sans-serif;font-weight:bold;font-size:14px;',
      'z-index:99999;box-shadow:0 4px 12px rgba(0,0,0,.15);transition:all .3s ease;max-width:360px;}',
      '.automation-running{background-color:#28a745;color:#fff;border-left:5px solid #218838;}',
      '.automation-stopped{background-color:#dc3545;color:#fff;border-left:5px solid #c82333;}',
      '.folder-click-animation{animation:pulse-blue .5s;}',
      '@keyframes pulse-blue{0%{box-shadow:0 0 0 0 rgba(0,123,255,.7);}',
      '70%{box-shadow:0 0 0 10px rgba(0,123,255,0);}100%{box-shadow:0 0 0 0 rgba(0,123,255,0);}}'
    ].join('');
    document.head.appendChild(style);
  }

  function criarNotificacao() {
    if (notificacao && notificacao.isConnected) return;
    if (!document.body) return;
    notificacao = document.getElementById('automation-notification');
    if (!notificacao) {
      notificacao = document.createElement('div');
      notificacao.id = 'automation-notification';
      document.body.appendChild(notificacao);
    }
    notificacao.className = 'automation-stopped';
    notificacao.textContent = 'Automação: PARADA';
  }

  function atualizarNotificacao(mensagem) {
    if (!notificacao || !notificacao.isConnected) criarNotificacao();
    if (!notificacao) return;
    if (mensagem) {
      notificacao.className = 'automation-stopped';
      notificacao.textContent = mensagem;
      return;
    }
    if (rodando) {
      notificacao.className = 'automation-running';
      notificacao.textContent = 'Automação: ' + estado;
    } else {
      notificacao.className = 'automation-stopped';
      notificacao.textContent = 'Automação: PARADA';
    }
  }

  /* ============================ PERSISTÊNCIA ============================== */

  function temStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  let timerGravacao = null;
  function salvarProgresso(imediato) {
    if (!temStorage()) return;
    const gravar = () => {
      timerGravacao = null;
      const dados = {
        fase: estado,
        rodando: rodando,
        ultimoCodigo: progresso.ultimoCodigo,
        transformados: Array.from(progresso.transformados).slice(-MAX_HISTORICO),
        bloqueados: Array.from(progresso.bloqueados).slice(-MAX_HISTORICO),
        alvo: alvo ? alvo.codigo : null,
        atualizadoEm: Date.now()
      };
      try { chrome.storage.local.set({ [CHAVE_PROGRESSO]: dados }); } catch (e) {}
    };
    if (imediato) {
      if (timerGravacao) { clearTimeout(timerGravacao); timerGravacao = null; }
      gravar();
    } else if (!timerGravacao) {
      timerGravacao = setTimeout(gravar, 250);
    }
  }

  function carregarProgresso() {
    return new Promise((resolve) => {
      if (!temStorage()) return resolve(null);
      try {
        chrome.storage.local.get([CHAVE_PROGRESSO], (r) => {
          const d = r && r[CHAVE_PROGRESSO];
          if (d) {
            progresso.ultimoCodigo = Number(d.ultimoCodigo) || 0;
            (d.transformados || []).forEach((c) => progresso.transformados.add(Number(c)));
            (d.bloqueados || []).forEach((c) => progresso.bloqueados.add(Number(c)));
          }
          resolve(d || null);
        });
      } catch (e) { resolve(null); }
    });
  }

  function carregarConfig() {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync) return resolve(CONFIG);
      try {
        chrome.storage.sync.get(['refreshInterval', 'validationTimeout', 'requireStatus', 'isRunning'], (r) => {
          aplicarConfig(r || {});
          resolve(r || {});
        });
      } catch (e) { resolve({}); }
    });
  }

  function aplicarConfig(c) {
    if (!c) return;
    if (c.refreshInterval != null && !isNaN(c.refreshInterval)) {
      CONFIG.refreshInterval = Math.min(60000, Math.max(0, parseInt(c.refreshInterval, 10)));
    }
    if (c.validationTimeout != null && !isNaN(c.validationTimeout)) {
      CONFIG.validationTimeout = Math.min(60000, Math.max(1000, parseInt(c.validationTimeout, 10)));
    }
    if (c.requireStatus != null) CONFIG.requireStatus = !!c.requireStatus;
  }

  /* ===================== TRAVA DE DONO (1 aba/frame) ====================== */

  function obterDono() {
    return new Promise((resolve) => {
      if (!temStorage()) return resolve(null);
      try {
        chrome.storage.local.get([CHAVE_DONO], (r) => resolve((r && r[CHAVE_DONO]) || null));
      } catch (e) { resolve(null); }
    });
  }

  function gravarDono() {
    if (!temStorage()) return Promise.resolve();
    ultimoToqueDono = Date.now();
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({
          [CHAVE_DONO]: { instancia: INSTANCIA, tabId: meuTabId, ts: Date.now() }
        }, resolve);
      } catch (e) { resolve(); }
    });
  }

  async function assumirControle() {
    if (!temStorage()) return true;
    const dono = await obterDono();
    const expirado = !dono || !dono.ts || (Date.now() - dono.ts) > LOCK_TTL;
    if (dono && dono.instancia === INSTANCIA) { await gravarDono(); return true; }
    if (!expirado) {
      log('Outra aba/frame já está executando a automação — esta instância ficará em espera.');
      return false;
    }
    await gravarDono();
    await sleep(40);
    const confirmado = await obterDono();
    return !!(confirmado && confirmado.instancia === INSTANCIA);
  }

  function manterControle() {
    if (Date.now() - ultimoToqueDono > 3000) gravarDono();
  }

  function liberarControle() {
    if (!temStorage()) return;
    obterDono().then((d) => {
      if (d && d.instancia === INSTANCIA) {
        try { chrome.storage.local.remove(CHAVE_DONO); } catch (e) {}
      }
    });
  }

  /* ========================= LEITURA DA PÁGINA ============================ */

  function paginaAtual() {
    const hash = location.hash || '';
    if (RE_ROTA_ACOMPANHAMENTO.test(hash)) return 'ACOMPANHAMENTO';
    if (hash.indexOf(ROTA_LISTA) === 0) return 'LISTA';

    const titulo = document.querySelector('label.uppercase.titulo-funcionalidade');
    if (titulo) {
      const t = normalizar(titulo.textContent);
      if (RE_TITULO_ACOMPANHAMENTO.test(t)) return 'ACOMPANHAMENTO';
      if (t === 'PRE-PEDIDOS') return 'LISTA';
    }
    if (lerTituloAcompanhamento()) return 'ACOMPANHAMENTO';
    if (encontrarTabela()) return 'LISTA';
    return 'OUTRA';
  }

  function codigoDaUrl() {
    const m = (location.hash || '').match(RE_ROTA_ACOMPANHAMENTO);
    return m ? parseInt(m[1], 10) : null;
  }

  /** Lê o título "ACOMPANHAMENTO DO PRÉ-PEDIDO 262614 (MÓVEL)". */
  function lerTituloAcompanhamento() {
    const candidatos = [];
    const preferido = document.querySelector('label.uppercase.titulo-funcionalidade');
    if (preferido) candidatos.push(preferido);
    document.querySelectorAll('label, h1, h2, h3, h4, .titulo-funcionalidade').forEach((el) => {
      if (el !== preferido) candidatos.push(el);
    });
    for (let i = 0; i < candidatos.length; i++) {
      const m = normalizar(candidatos[i].textContent).match(RE_TITULO_ACOMPANHAMENTO);
      if (m) {
        return {
          codigo: parseInt(m[1], 10),
          tipo: normalizar(m[2] || ''),
          texto: String(candidatos[i].textContent || '').trim()
        };
      }
    }
    return null;
  }

  /* --------------------------- Tabela / linhas ---------------------------- */

  function mapearColunas(tabela) {
    const mapa = { codigo: -1, tipo: -1, status: -1 };
    const linhas = tabela.querySelectorAll('thead tr');
    for (let l = 0; l < linhas.length; l++) {
      const celulas = linhas[l].children;
      for (let i = 0; i < celulas.length; i++) {
        const txt = normalizar(celulas[i].textContent);
        if (!txt) continue;
        if (mapa.codigo < 0 && /(^|[^A-Z])CODIGO([^A-Z]|$)/.test(txt)) mapa.codigo = i;
        if (mapa.tipo < 0 && /(^|[^A-Z])TIPO([^A-Z]|$)/.test(txt)) mapa.tipo = i;
        if (mapa.status < 0 && txt.indexOf('STATUS PERSONALIZADO') >= 0) mapa.status = i;
      }
    }
    return mapa;
  }

  /** Localiza a tabela de pré-pedidos pelos cabeçalhos CÓDIGO + TIPO. */
  function encontrarTabela() {
    const tabelas = document.querySelectorAll('table');
    for (let i = 0; i < tabelas.length; i++) {
      const mapa = mapearColunas(tabelas[i]);
      if (mapa.codigo >= 0 && mapa.tipo >= 0) return { tabela: tabelas[i], colunas: mapa };
    }
    // fallback: tabela sem cabeçalho reconhecível, mas com linhas de pedido válidas
    const semCabecalho = { codigo: -1, tipo: -1, status: -1 };
    for (let i = 0; i < tabelas.length; i++) {
      if (lerLinhasDaTabela(tabelas[i], semCabecalho).length > 0) {
        return { tabela: tabelas[i], colunas: semCabecalho };
      }
    }
    return null;
  }

  function textoDaCelula(celulas, indice) {
    if (indice < 0 || !celulas || indice >= celulas.length) return null;
    return normalizar(celulas[indice].textContent);
  }

  function extrairCodigo(texto) {
    if (!texto) return null;
    const m = String(texto).trim().match(/^(\d{3,9})$/);
    return m ? parseInt(m[1], 10) : null;
  }

  /** Detecta o código varrendo as células (ignora CNPJ/CPF, que têm 11+ dígitos). */
  function detectarCodigoPorTexto(celulas) {
    for (let i = 0; i < celulas.length; i++) {
      const c = extrairCodigo(normalizar(celulas[i].textContent));
      if (c !== null) return c;
    }
    return null;
  }

  function detectarTipoPorTexto(celulas) {
    for (let i = 0; i < celulas.length; i++) {
      const t = normalizar(celulas[i].textContent);
      if (TIPOS_CONHECIDOS.indexOf(t) >= 0) return t;
    }
    return null;
  }

  /** Lê uma linha da tabela e devolve { tr, codigo, tipo, status }. */
  function lerLinha(tr, colunas) {
    if (!tr || !tr.cells || tr.cells.length === 0) return null;
    // linhas de cabeçalho/filtro não são pedidos (uma linha de dados pode ter
    // checkbox ou campo inline, por isso a checagem é pelo <thead>, não por input)
    if (tr.closest && tr.closest('thead')) return null;

    const celulas = tr.cells;

    let codigo = extrairCodigo(textoDaCelula(celulas, colunas.codigo));
    if (codigo === null) codigo = detectarCodigoPorTexto(celulas);
    if (codigo === null) return null;

    let tipo = textoDaCelula(celulas, colunas.tipo);
    if (TIPOS_CONHECIDOS.indexOf(tipo) < 0) {
      const detectado = detectarTipoPorTexto(celulas);
      if (detectado) tipo = detectado;
    }

    let status = textoDaCelula(celulas, colunas.status);
    if (status === null) {
      const celulaStatus = tr.querySelector('[ng-class*="statusPersonalizado"], [ng-bind*="statusPersonalizado"]');
      if (celulaStatus) status = normalizar(celulaStatus.textContent);
    }

    return { tr: tr, codigo: codigo, tipo: tipo || '', status: status || '' };
  }

  function lerLinhasDaTabela(tabela, colunas) {
    const linhas = [];
    const corpos = tabela.tBodies && tabela.tBodies.length
      ? Array.prototype.slice.call(tabela.tBodies)
      : [tabela];
    corpos.forEach((corpo) => {
      const trs = corpo.rows ? corpo.rows : corpo.querySelectorAll('tr');
      for (let i = 0; i < trs.length; i++) {
        const info = lerLinha(trs[i], colunas);
        if (info) linhas.push(info);
      }
    });
    return linhas;
  }

  function lerLinhas() {
    const ctx = encontrarTabela();
    if (!ctx) return [];
    return lerLinhasDaTabela(ctx.tabela, ctx.colunas);
  }

  /**
   * Encontra, DENTRO DA LINHA, o elemento que abre o acompanhamento
   * (segundo ícone da esquerda / pasta azul).
   */
  function encontrarBotaoAcompanhamento(tr, codigo) {
    const icones = iconesDaLinha(tr);

    // 1) link cuja rota aponta exatamente para o código deste pedido
    const links = tr.querySelectorAll('a[href]');
    for (let i = 0; i < links.length; i++) {
      const alvoHref = ((links[i].getAttribute('href') || '').match(/acompanhamento\/(\d+)/i) || [])[1];
      if (alvoHref && parseInt(alvoHref, 10) === codigo) return { el: links[i], via: 'rota' };
    }

    // 2) ícone de pasta dentro da linha
    const pasta = tr.querySelector(
      '.fa-folder-open, .fa-folder-open-o, .fa-folder, [class*="folder-open"], [class*="fa-folder"], [class*="pasta"]'
    );
    if (pasta) return { el: elementoClicavel(pasta), via: 'pasta' };

    // 3) elementos que citam a rota de acompanhamento; se houver mais de um na
    //    mesma linha (ex.: editar + abrir), prefere o que está na 2ª posição.
    const porRota = [];
    const candidatos = tr.querySelectorAll('a[href], [ng-click], [data-ng-click], [onclick]');
    for (let i = 0; i < candidatos.length; i++) {
      const el = candidatos[i];
      const href = el.getAttribute('href') || '';
      const ng = el.getAttribute('ng-click') || el.getAttribute('data-ng-click') || el.getAttribute('onclick') || '';
      if (/acompanhamento/i.test(href) || /acompanhamento/i.test(ng)) {
        const alvoHref = (href.match(/acompanhamento\/(\d+)/i) || [])[1];
        if (alvoHref && parseInt(alvoHref, 10) !== codigo) continue;  // rota de outro pedido
        porRota.push(el);
      }
    }
    if (porRota.length === 1) return { el: porRota[0], via: 'rota' };
    if (porRota.length > 1) {
      const segundo = icones.length > 1 ? icones[1] : null;
      const preferido = segundo && porRota.indexOf(segundo) >= 0 ? segundo : porRota[0];
      return { el: preferido, via: 'rota-ambigua' };
    }

    // 4) segundo ícone clicável da esquerda para a direita
    if (icones.length > 1) return { el: icones[1], via: 'posicao' };

    return null;
  }

  function elementoClicavel(el) {
    const c = el.closest ? el.closest('a,button,[ng-click],[data-ng-click],[onclick]') : null;
    return c || el;
  }

  function iconesDaLinha(tr) {
    const brutos = tr.querySelectorAll('i, svg, img, a, button, [ng-click], [data-ng-click]');
    const lista = [];
    for (let i = 0; i < brutos.length; i++) {
      const alvoClique = elementoClicavel(brutos[i]);
      if (!alvoClique) continue;
      if (lista.indexOf(alvoClique) >= 0) continue;
      if (lista.some((j) => j.contains && j.contains(alvoClique))) continue;
      lista.push(alvoClique);
    }
    return lista;
  }

  /* ------------------------ Filtro TIPO = Móvel --------------------------- */

  function encontrarFiltroTipo() {
    const selects = document.querySelectorAll('select');
    for (let i = 0; i < selects.length; i++) {
      const textos = Array.prototype.map.call(selects[i].options || [], (o) => normalizar(o.textContent));
      if (textos.indexOf(TIPO_ALVO) >= 0 &&
          textos.some((t) => t === 'FIXO' || t === 'VSTI' || t === 'AVANCADA')) {
        return selects[i];
      }
    }
    return null;
  }

  /** Fallback: opção "Móvel" clicável (li/label/checkbox) dentro do cabeçalho. */
  function encontrarOpcaoMovelClicavel() {
    const escopos = document.querySelectorAll('thead, .filtros, .filtro, .dropdown-menu');
    for (let i = 0; i < escopos.length; i++) {
      const itens = escopos[i].querySelectorAll('li, label, a, span, div');
      for (let j = 0; j < itens.length; j++) {
        if (normalizar(itens[j].textContent) === TIPO_ALVO && visivel(itens[j])) return itens[j];
      }
    }
    return null;
  }

  function movelSelecionado(select) {
    if (!select) return false;
    const opts = select.options || [];
    for (let i = 0; i < opts.length; i++) {
      if (normalizar(opts[i].textContent) === TIPO_ALVO && opts[i].selected) return true;
    }
    return false;
  }

  /** Seleciona SOMENTE "Móvel" no filtro TIPO. Devolve true se algo mudou. */
  function selecionarSomenteMovel(select) {
    let mudou = false;
    const opts = select.options || [];
    for (let i = 0; i < opts.length; i++) {
      const eMovel = normalizar(opts[i].textContent) === TIPO_ALVO;
      if (select.multiple) {
        if (opts[i].selected !== eMovel) { opts[i].selected = eMovel; mudou = true; }
      } else if (eMovel && select.selectedIndex !== i) {
        select.selectedIndex = i;
        mudou = true;
      }
    }
    return mudou;
  }

  /** Observa a grade e resolve quando o conteúdo realmente mudar. */
  function observarGrade(timeout) {
    const ctx = encontrarTabela();
    const raiz = (ctx && ctx.tabela.parentElement) || document.body || document.documentElement;
    return new Promise((resolve) => {
      let mudou = false;
      let obs = null;
      let timerDebounce = null;
      const limite = setTimeout(() => finalizar(mudou), timeout != null ? timeout : Math.max(1200, CONFIG.validationTimeout / 2));

      function finalizar(resultado) {
        if (obs) obs.disconnect();
        clearTimeout(limite);
        if (timerDebounce) clearTimeout(timerDebounce);
        resolve(!!resultado);
      }
      try {
        obs = new MutationObserver(() => {
          mudou = true;
          if (timerDebounce) clearTimeout(timerDebounce);
          timerDebounce = setTimeout(() => finalizar(true), 120);
        });
        obs.observe(raiz, { childList: true, subtree: true, characterData: true });
      } catch (e) { finalizar(false); }
    });
  }

  /* ------------------- Campos da tela de acompanhamento ------------------- */

  function campoPorRotulo(rotuloAlvo) {
    const rotulos = document.querySelectorAll('label');
    for (let i = 0; i < rotulos.length; i++) {
      const l = rotulos[i];
      if (normalizar(l.textContent) !== rotuloAlvo) continue;

      if (l.htmlFor) {
        const porId = document.getElementById(l.htmlFor);
        if (porId && aceitaComoCampo(porId)) return porId;
      }
      let n = l.nextElementSibling;
      while (n) {
        if (/^(SELECT|INPUT|TEXTAREA)$/.test(n.tagName) && aceitaComoCampo(n)) return n;
        const dentro = n.querySelector && n.querySelector('select,input,textarea');
        if (dentro && aceitaComoCampo(dentro)) return dentro;
        n = n.nextElementSibling;
      }
      let p = l.parentElement;
      let nivel = 0;
      while (p && nivel++ < 2) {
        const c = p.querySelector('select,input,textarea');
        if (c && aceitaComoCampo(c)) return c;
        p = p.parentElement;
      }
    }
    return null;
  }

  /** Descarta campos que pertencem ao "Novo Status Personalizado". */
  function aceitaComoCampo(el) {
    const ng = (el.getAttribute && (el.getAttribute('ng-model') || el.getAttribute('data-ng-model'))) || '';
    const id = el.id || '';
    if (/novo/i.test(ng) || /novo/i.test(id)) return false;
    return true;
  }

  function encontrarCampoStatusAtual() {
    const porRotulo = campoPorRotulo('STATUS PERSONALIZADO ATUAL');
    if (porRotulo) return porRotulo;

    const selects = document.querySelectorAll('select[ng-model], input[ng-model], select[data-ng-model]');
    for (let i = 0; i < selects.length; i++) {
      const ng = selects[i].getAttribute('ng-model') || selects[i].getAttribute('data-ng-model') || '';
      if (/status/i.test(ng) && /atual/i.test(ng) && !/novo/i.test(ng)) return selects[i];
    }
    return null;
  }

  /**
   * Lê o "Status Personalizado Atual" do pedido aberto.
   * Retorna { ok, valor, vazio, motivo }.
   */
  function lerStatusAtual() {
    const campo = encontrarCampoStatusAtual();
    if (!campo) return { ok: false, motivo: 'campo-nao-encontrado' };

    let texto = '';
    if (campo.tagName === 'SELECT') {
      const opts = campo.options || [];
      if (!opts.length) return { ok: false, motivo: 'select-sem-opcoes' };
      if (campo.selectedIndex < 0) return { ok: false, motivo: 'sem-opcao-selecionada' };
      const opcao = opts[campo.selectedIndex];
      texto = opcao ? opcao.textContent : '';
      const valorBruto = String(opcao && opcao.value != null ? opcao.value : '');
      if (/^\?\s*(undefined|null)/.test(valorBruto)) return { ok: false, motivo: 'modelo-nao-carregado' };
    } else if (campo.tagName === 'INPUT' || campo.tagName === 'TEXTAREA') {
      texto = campo.value;
    } else {
      texto = campo.textContent;
    }

    const valor = normalizar(texto);
    if (!valor) return { ok: false, motivo: 'valor-vazio' };
    return { ok: true, valor: valor, vazio: STATUS_SEM_VALOR.indexOf(valor) >= 0 };
  }

  function statusBloqueado(valor) {
    return RE_STATUS_BLOQUEADO.test(valor || '');
  }

  function encontrarBotaoTransformar() {
    const botoes = document.querySelectorAll('button, a.btn, input[type="button"], input[type="submit"]');
    for (let i = 0; i < botoes.length; i++) {
      const b = botoes[i];
      const ng = b.getAttribute('ng-click') || b.getAttribute('data-ng-click') || '';
      const txt = normalizar(b.textContent || b.value || '');
      const combina = /exibirTemCerteza/i.test(ng) || txt.indexOf('TRANSFORMAR EM PEDIDO') === 0;
      if (combina && visivel(b)) return b;
    }
    return null;
  }

  /** Elementos que contêm o texto procurado e não têm descendente com o mesmo texto. */
  function elementosComTexto(trecho) {
    const alvoTexto = normalizar(trecho);
    const todos = document.querySelectorAll('label,span,p,div,h1,h2,h3,h4,h5,strong,b,td');
    const achados = [];
    for (let i = 0; i < todos.length; i++) {
      if (normalizar(todos[i].textContent).indexOf(alvoTexto) >= 0) achados.push(todos[i]);
    }
    return achados.filter((el) => !achados.some((outro) => outro !== el && el.contains(outro)));
  }

  function perguntaConfirmacaoVisivel() {
    const achados = elementosComTexto('TEM CERTEZA QUE DESEJA TRANSFORMAR');
    return achados.some((el) => visivel(el));
  }

  function encontrarBotaoSim() {
    const botoes = document.querySelectorAll('button, a.btn, input[type="button"]');
    for (let i = 0; i < botoes.length; i++) {
      const b = botoes[i];
      const ng = b.getAttribute('ng-click') || b.getAttribute('data-ng-click') || '';
      const txt = normalizar(b.textContent || b.value || '');
      const classes = String(b.className || '');
      // NUNCA confundir com o botão "Não"
      if (txt === 'NAO' || /btn-danger/.test(classes)) continue;
      const combina = /transformarEmPedido\s*\(/i.test(ng) || (txt === 'SIM' && /btn-success/.test(classes));
      if (combina && visivel(b)) return b;
    }
    return null;
  }

  /* ========================= CONTROLE DE FILA ============================= */

  async function aguardarIntervalo() {
    const restante = CONFIG.refreshInterval - (Date.now() - ultimaAtualizacao);
    if (restante > 0) {
      log('Aguardando ' + restante + ' ms antes da próxima atualização (intervalo configurado: ' + CONFIG.refreshInterval + ' ms)');
      await sleep(restante);
    }
  }

  /**
   * Atualiza a fila re-aplicando o filtro TIPO = Móvel.
   * Nunca executa duas atualizações simultaneamente e respeita o intervalo mínimo.
   */
  async function atualizarFila(motivo) {
    if (atualizandoFila) {
      log('Atualização já em andamento — ignorando pedido duplicado (' + motivo + ')');
      return false;
    }
    atualizandoFila = true;
    try {
      await aguardarIntervalo();
      if (!rodando) return false;

      const select = encontrarFiltroTipo();
      let disparou = false;

      if (select) {
        const mudou = selecionarSomenteMovel(select);
        log('Atualizando filtro Móvel' + (motivo ? ' (' + motivo + ')' : '') + (mudou ? ' — seleção ajustada' : ' — reaplicando seleção'));
        const promessaGrade = observarGrade();
        dispararMudanca(select);
        if (estrategiaAtualizacao >= 1) {
          const opcao = opcaoMovelDoSelect(select);
          if (opcao) clicarComEventos(opcao);
        }
        disparou = true;
        const houveMudanca = await promessaGrade;
        semMudancaNaGrade = houveMudanca ? 0 : semMudancaNaGrade + 1;
      } else {
        const opcao = encontrarOpcaoMovelClicavel();
        if (opcao) {
          log('Atualizando filtro Móvel (elemento clicável)' + (motivo ? ' — ' + motivo : ''));
          const promessaGrade = observarGrade();
          clicar(opcao);
          disparou = true;
          const houveMudanca = await promessaGrade;
          semMudancaNaGrade = houveMudanca ? 0 : semMudancaNaGrade + 1;
        } else {
          aviso('Filtro TIPO não encontrado — tentando botão de busca da grade');
        }
      }

      if (!disparou || semMudancaNaGrade >= 3) {
        await estrategiaAlternativa();
      }

      ultimaAtualizacao = Date.now();
      return true;
    } finally {
      atualizandoFila = false;
    }
  }

  function opcaoMovelDoSelect(select) {
    const opts = select.options || [];
    for (let i = 0; i < opts.length; i++) {
      if (normalizar(opts[i].textContent) === TIPO_ALVO) return opts[i];
    }
    return null;
  }

  /** Escalonamento: só é usado quando a re-aplicação do filtro não surte efeito. */
  async function estrategiaAlternativa() {
    estrategiaAtualizacao = Math.min(estrategiaAtualizacao + 1, 3);
    semMudancaNaGrade = 0;

    const botaoBusca = document.querySelector(
      '[ng-click*="buscar"], [ng-click*="pesquisar"], [ng-click*="filtrar"], [ng-click*="atualizar"], [ng-click*="listar"], [ng-click*="carregar"]'
    );
    if (botaoBusca && visivel(botaoBusca)) {
      log('Estratégia alternativa: acionando botão de busca/atualização da grade');
      const promessa = observarGrade();
      clicar(botaoBusca);
      await promessa;
      return;
    }

    const ctx = encontrarTabela();
    const campoFiltro = ctx ? ctx.tabela.querySelector('thead input[type="text"], thead input:not([type])') : null;
    if (campoFiltro) {
      log('Estratégia alternativa (último recurso): confirmando o filtro com Enter');
      const promessa = observarGrade();
      campoFiltro.focus && campoFiltro.focus();
      ['keydown', 'keypress', 'keyup'].forEach((tipo) => {
        try {
          campoFiltro.dispatchEvent(new KeyboardEvent(tipo, {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
          }));
        } catch (e) {}
      });
      await promessa;
    }
  }

  /* ======================= PROGRESSO / BLOQUEIOS ========================== */

  function avancarFila(codigo) {
    if (codigo > progresso.ultimoCodigo) progresso.ultimoCodigo = codigo;
  }

  function bloquear(codigo, motivo) {
    progresso.bloqueados.add(codigo);
    avancarFila(codigo);
    log('Pedido bloqueado: ' + codigo + ' — ' + motivo);
    log('Último código bloqueado: ' + codigo);
    salvarProgresso(true);
  }

  function registrarTransformado(codigo) {
    progresso.transformados.add(codigo);
    avancarFila(codigo);
    salvarProgresso(true);
  }

  function contarTentativa(codigo) {
    progresso.tentativas[codigo] = (progresso.tentativas[codigo] || 0) + 1;
    return progresso.tentativas[codigo];
  }

  function jaTratado(codigo) {
    return progresso.transformados.has(codigo) || progresso.bloqueados.has(codigo);
  }

  /**
   * Escolhe o próximo pedido MÓVEL elegível:
   * menor código estritamente MAIOR que o último processado/bloqueado.
   * Pedidos CANCELADOS visíveis na fila são descartados em ordem crescente,
   * avançando o marcador sem nunca ultrapassar um pedido válido.
   */
  function escolherProximo(linhas) {
    const movel = linhas.filter((l) => l.tipo === TIPO_ALVO);
    const outros = linhas.length - movel.length;
    log('Fila: ' + linhas.length + ' linha(s) | Móvel: ' + movel.length + ' | outros tipos ignorados: ' + outros);

    const candidatos = movel
      .filter((l) => l.codigo > progresso.ultimoCodigo && !jaTratado(l.codigo))
      .sort((a, b) => a.codigo - b.codigo);

    if (!candidatos.length) return null;

    for (let i = 0; i < candidatos.length; i++) {
      const linha = candidatos[i];
      if (statusBloqueado(linha.status)) {
        log('Pedido encontrado: ' + linha.codigo);
        log('Tipo: Móvel');
        log('Status na fila: ' + linha.status);
        bloquear(linha.codigo, 'CANCELADO (detectado na própria linha da fila)');
        continue;
      }
      return linha;
    }
    return null;
  }

  /* ========================= MÁQUINA DE ESTADOS =========================== */

  function irPara(novoEstado) {
    if (estado !== novoEstado) {
      estado = novoEstado;
      atualizarNotificacao();
      salvarProgresso(false);
    }
    return novoEstado;
  }

  async function passoProcurandoPedido() {
    if (paginaAtual() !== 'LISTA') return irPara(E.RETORNANDO_FILA);
    urlDaLista = location.href;

    const linhas = await esperarPor(() => {
      const l = lerLinhas();
      return l.length ? l : null;
    }, { timeout: Math.max(2000, CONFIG.validationTimeout / 2) });

    if (!linhas) {
      log('Nenhuma linha visível na fila — solicitando atualização');
      return irPara(E.ATUALIZANDO_FILA);
    }

    const escolhido = escolherProximo(linhas);
    if (!escolhido) return irPara(E.AGUARDANDO_NOVO_CODIGO);

    esperasSemCodigo = 0;
    alvo = {
      codigo: escolhido.codigo,
      tipo: escolhido.tipo,
      statusFila: escolhido.status,
      tr: escolhido.tr,
      transformarClicado: false,
      simClicado: false
    };
    log('Pedido encontrado: ' + alvo.codigo);
    log('Tipo: ' + (alvo.tipo === TIPO_ALVO ? 'Móvel' : alvo.tipo));
    return irPara(E.VALIDANDO_LINHA);
  }

  /** PRIMEIRA VALIDAÇÃO — feita na linha da tabela. */
  async function passoValidandoLinha() {
    if (!alvo) return irPara(E.PROCURANDO_PEDIDO);

    let linha = null;
    if (alvo.tr && alvo.tr.isConnected) {
      const ctx = encontrarTabela();
      linha = lerLinha(alvo.tr, ctx ? ctx.colunas : { codigo: -1, tipo: -1, status: -1 });
    }
    if (!linha || linha.codigo !== alvo.codigo) {
      // a grade foi re-renderizada: procura a linha do mesmo código
      linha = lerLinhas().find((l) => l.codigo === alvo.codigo) || null;
    }
    if (!linha) {
      aviso('Linha do pedido ' + alvo.codigo + ' não está mais na fila — reiniciando busca');
      alvo = null;
      return irPara(E.PROCURANDO_PEDIDO);
    }

    if (linha.tipo !== TIPO_ALVO) {
      bloquear(alvo.codigo, 'tipo diferente de Móvel na linha (' + (linha.tipo || 'desconhecido') + ')');
      alvo = null;
      return irPara(E.RETORNANDO_FILA);
    }
    if (statusBloqueado(linha.status)) {
      bloquear(alvo.codigo, 'CANCELADO (status da própria linha)');
      alvo = null;
      return irPara(E.RETORNANDO_FILA);
    }

    const botao = encontrarBotaoAcompanhamento(linha.tr, alvo.codigo);
    if (!botao || !botao.el) {
      const tentativas = contarTentativa(alvo.codigo);
      aviso('Ícone de acompanhamento não encontrado na linha ' + alvo.codigo + ' (tentativa ' + tentativas + ')');
      if (tentativas >= MAX_TENTATIVAS_POR_CODIGO) {
        bloquear(alvo.codigo, 'não foi possível localizar o ícone de acompanhamento na linha');
        alvo = null;
        return irPara(E.RETORNANDO_FILA);
      }
      alvo = null;
      return irPara(E.ATUALIZANDO_FILA);
    }

    alvo.tr = linha.tr;
    alvo.botao = botao.el;
    alvo.viaBotao = botao.via;
    log('Linha validada: código ' + alvo.codigo + ' / tipo Móvel / ícone localizado (' + botao.via + ')');
    return irPara(E.ABRINDO_ACOMPANHAMENTO);
  }

  async function passoAbrindoAcompanhamento() {
    if (!alvo) return irPara(E.PROCURANDO_PEDIDO);
    if (navegando) { await sleep(60); return estado; }

    navegando = true;
    try {
      urlDaLista = location.href;
      log('Abrindo acompanhamento: ' + alvo.codigo);
      clicar(alvo.botao);

      let destino = await esperarPor(() => {
        const c = codigoDaUrl();
        return c !== null ? { codigo: c } : (lerTituloAcompanhamento() || null);
      }, { timeout: Math.max(3000, CONFIG.validationTimeout) });

      if (!destino) {
        // segunda tentativa: eventos completos de mouse
        clicarComEventos(alvo.botao);
        destino = await esperarPor(() => {
          const c = codigoDaUrl();
          return c !== null ? { codigo: c } : (lerTituloAcompanhamento() || null);
        }, { timeout: Math.max(2000, CONFIG.validationTimeout / 2) });
      }

      if (!destino) {
        const tentativas = contarTentativa(alvo.codigo);
        aviso('Não foi possível abrir o acompanhamento de ' + alvo.codigo + ' (tentativa ' + tentativas + ')');
        if (tentativas >= MAX_TENTATIVAS_POR_CODIGO) {
          bloquear(alvo.codigo, 'falha ao abrir a tela de acompanhamento');
          alvo = null;
          return irPara(E.RETORNANDO_FILA);
        }
        alvo = null;
        return irPara(E.ATUALIZANDO_FILA);
      }
      return irPara(E.VALIDANDO_PEDIDO);
    } finally {
      navegando = false;
    }
  }

  /** SEGUNDA VALIDAÇÃO — feita dentro da tela de acompanhamento. */
  async function passoValidandoPedido() {
    if (!alvo) return irPara(E.RETORNANDO_FILA);

    const titulo = await esperarPor(() => lerTituloAcompanhamento(), { timeout: CONFIG.validationTimeout });
    const codigoUrl = codigoDaUrl();

    if (codigoUrl !== null && codigoUrl !== alvo.codigo) {
      erro('Pedido aberto (' + codigoUrl + ') é diferente do selecionado (' + alvo.codigo + ') — abortando');
      contarTentativa(alvo.codigo);
      alvo = null;
      return irPara(E.RETORNANDO_FILA);
    }
    if (!titulo) {
      const tentativas = contarTentativa(alvo.codigo);
      aviso('Título do acompanhamento não confirmado para ' + alvo.codigo + ' (tentativa ' + tentativas + ')');
      if (tentativas >= MAX_TENTATIVAS_POR_CODIGO) bloquear(alvo.codigo, 'não foi possível confirmar o pedido na tela de acompanhamento');
      alvo = null;
      return irPara(E.RETORNANDO_FILA);
    }
    if (titulo.codigo !== alvo.codigo) {
      erro('Título informa o pedido ' + titulo.codigo + ', mas o selecionado é ' + alvo.codigo + ' — abortando');
      contarTentativa(alvo.codigo);
      alvo = null;
      return irPara(E.RETORNANDO_FILA);
    }
    if (titulo.tipo && titulo.tipo !== TIPO_ALVO) {
      bloquear(alvo.codigo, 'tipo informado na tela de acompanhamento é ' + titulo.tipo + ' (fora do setor Móvel)');
      alvo = null;
      return irPara(E.RETORNANDO_FILA);
    }
    if (jaTratado(alvo.codigo)) {
      log('Pedido ' + alvo.codigo + ' já foi tratado anteriormente — nada a fazer');
      alvo = null;
      return irPara(E.RETORNANDO_FILA);
    }

    log('Pedido confirmado na tela de acompanhamento: ' + alvo.codigo + ' (' + (titulo.tipo || TIPO_ALVO) + ')');
    return irPara(E.VALIDANDO_STATUS);
  }

  async function passoValidandoStatus() {
    if (!alvo) return irPara(E.RETORNANDO_FILA);

    const leitura = await esperarPor(() => {
      const r = lerStatusAtual();
      return r.ok ? r : null;
    }, { timeout: CONFIG.validationTimeout });

    if (!leitura) {
      const detalhe = lerStatusAtual();
      const motivo = detalhe.motivo || 'desconhecido';
      const tentativas = contarTentativa(alvo.codigo);
      aviso('Status atual do pedido ' + alvo.codigo + ' não pôde ser lido (' + motivo + ') — tentativa ' + tentativas + '. NÃO será transformado agora.');
      if (tentativas >= MAX_TENTATIVAS_POR_CODIGO) {
        bloquear(alvo.codigo, 'status atual não pôde ser identificado com segurança (' + motivo + ')');
      }
      alvo = null;
      return irPara(E.RETORNANDO_FILA);
    }

    log('Status atual: ' + leitura.valor);

    if (statusBloqueado(leitura.valor)) {
      alvo.statusFinal = leitura.valor;
      return irPara(E.BLOQUEADO);
    }
    if (leitura.vazio && CONFIG.requireStatus) {
      bloquear(alvo.codigo, 'status não definido ("' + leitura.valor + '") e a opção "Exigir status definido" está ativa');
      alvo = null;
      return irPara(E.RETORNANDO_FILA);
    }

    alvo.statusFinal = leitura.valor;
    log('Status validado');
    return irPara(E.TRANSFORMANDO);
  }

  /** Revalida tudo imediatamente antes de qualquer clique de transformação. */
  function autorizacaoFinal() {
    if (!alvo) return { ok: false, motivo: 'sem alvo' };
    const codigoUrl = codigoDaUrl();
    if (codigoUrl !== null && codigoUrl !== alvo.codigo) return { ok: false, motivo: 'URL aponta para outro pedido (' + codigoUrl + ')' };
    const titulo = lerTituloAcompanhamento();
    if (!titulo) return { ok: false, motivo: 'título do pedido não está mais visível' };
    if (titulo.codigo !== alvo.codigo) return { ok: false, motivo: 'título aponta para o pedido ' + titulo.codigo };
    if (titulo.tipo && titulo.tipo !== TIPO_ALVO) return { ok: false, motivo: 'tipo ' + titulo.tipo + ' fora do setor Móvel' };
    const status = lerStatusAtual();
    if (!status.ok) return { ok: false, motivo: 'status ilegível (' + status.motivo + ')' };
    if (statusBloqueado(status.valor)) return { ok: false, motivo: 'status ' + status.valor, cancelado: true };
    if (status.vazio && CONFIG.requireStatus) return { ok: false, motivo: 'status não definido' };
    if (jaTratado(alvo.codigo)) return { ok: false, motivo: 'pedido já tratado' };
    return { ok: true, status: status.valor };
  }

  async function passoTransformando() {
    if (!alvo) return irPara(E.RETORNANDO_FILA);
    if (alvo.transformarClicado) return irPara(E.CONFIRMANDO);

    const autorizacao = autorizacaoFinal();
    if (!autorizacao.ok) {
      if (autorizacao.cancelado) return irPara(E.BLOQUEADO);
      aviso('Transformação NÃO autorizada para ' + alvo.codigo + ': ' + autorizacao.motivo);
      bloquear(alvo.codigo, autorizacao.motivo);
      alvo = null;
      return irPara(E.RETORNANDO_FILA);
    }

    const botao = await esperarPor(() => encontrarBotaoTransformar(), { timeout: CONFIG.validationTimeout });
    if (!botao) {
      bloquear(alvo.codigo, 'botão "Transformar em Pedido" indisponível');
      alvo = null;
      return irPara(E.RETORNANDO_FILA);
    }

    // revalidação logo antes do clique (o DOM pode ter mudado durante a espera)
    const revalidacao = autorizacaoFinal();
    if (!revalidacao.ok) {
      if (revalidacao.cancelado) return irPara(E.BLOQUEADO);
      bloquear(alvo.codigo, revalidacao.motivo);
      alvo = null;
      return irPara(E.RETORNANDO_FILA);
    }

    log('Transformação autorizada');
    log('Clicando em Transformar em Pedido');
    alvo.transformarClicado = true;
    clicar(botao);
    return irPara(E.CONFIRMANDO);
  }

  async function passoConfirmando() {
    if (!alvo) return irPara(E.RETORNANDO_FILA);
    if (alvo.simClicado) return irPara(E.CONCLUIDO);

    const botaoSim = await esperarPor(() => {
      const b = encontrarBotaoSim();
      return b && perguntaConfirmacaoVisivel() ? b : null;
    }, { timeout: CONFIG.validationTimeout });

    if (!botaoSim) {
      aviso('Confirmação não apareceu para o pedido ' + alvo.codigo + ' — abortando sem transformar');
      contarTentativa(alvo.codigo);
      alvo = null;
      return irPara(E.RETORNANDO_FILA);
    }

    // Última verificação antes do clique definitivo
    const autorizacao = autorizacaoFinal();
    if (!autorizacao.ok) {
      if (autorizacao.cancelado) {
        aviso('Status CANCELADO detectado com a confirmação aberta — saindo sem clicar em "Sim"');
        return irPara(E.BLOQUEADO);
      }
      aviso('Confirmação abortada para ' + alvo.codigo + ': ' + autorizacao.motivo);
      bloquear(alvo.codigo, autorizacao.motivo);
      alvo = null;
      return irPara(E.RETORNANDO_FILA);
    }

    // registra ANTES de clicar: evita qualquer chance de duplicidade
    alvo.simClicado = true;
    registrarTransformado(alvo.codigo);
    log('Confirmando transformação');
    clicar(botaoSim);
    return irPara(E.CONCLUIDO);
  }

  async function passoConcluido() {
    if (!alvo) return irPara(E.RETORNANDO_FILA);
    const codigo = alvo.codigo;

    const fim = await esperarPor(() => {
      const codigoUrl = codigoDaUrl();
      if (codigoUrl !== null && codigoUrl !== codigo) return 'rota-mudou';
      if (!perguntaConfirmacaoVisivel() && !encontrarBotaoSim()) return 'confirmacao-encerrada';
      return null;
    }, { timeout: Math.max(4000, CONFIG.validationTimeout) });

    if (fim) log('Pedido ' + codigo + ' transformado');
    else aviso('Não foi possível confirmar a conclusão de ' + codigo + ' — seguindo para o próximo (não será repetido)');

    alvo = null;
    return irPara(E.RETORNANDO_FILA);
  }

  async function passoBloqueado() {
    if (!alvo) return irPara(E.RETORNANDO_FILA);
    log('Pedido bloqueado: CANCELADO');
    bloquear(alvo.codigo, 'CANCELADO (status confirmado na tela de acompanhamento)');
    alvo = null;
    return irPara(E.RETORNANDO_FILA);
  }

  async function passoRetornandoFila() {
    alvo = null;
    if (paginaAtual() === 'LISTA') return irPara(E.ATUALIZANDO_FILA);
    if (navegando) { await sleep(60); return estado; }

    navegando = true;
    try {
      log('Retornando para a fila');
      const destino = urlDaLista || (location.origin + location.pathname + ROTA_LISTA);
      if (location.href !== destino) location.href = destino;
      else location.hash = ROTA_LISTA;

      const chegou = await esperarPor(() => (paginaAtual() === 'LISTA' ? true : null), {
        timeout: Math.max(4000, CONFIG.validationTimeout)
      });
      if (!chegou) {
        aviso('Ainda não foi possível voltar para a lista de pré-pedidos — tentando novamente');
        return estado;
      }
      // a própria navegação já recarrega a grade: conta como atualização
      ultimaAtualizacao = Date.now();
      return irPara(E.ATUALIZANDO_FILA);
    } finally {
      navegando = false;
    }
  }

  async function passoAtualizandoFila() {
    if (paginaAtual() !== 'LISTA') return irPara(E.RETORNANDO_FILA);

    const select = encontrarFiltroTipo();
    const filtroOk = select ? movelSelecionado(select) : false;
    const temLinhas = lerLinhas().length > 0;

    // Se o filtro já está em Móvel e a grade já tem linhas carregadas, não
    // gera uma requisição extra: apenas procura o próximo pedido.
    if (filtroOk && temLinhas && Date.now() - ultimaAtualizacao < CONFIG.refreshInterval) {
      return irPara(E.PROCURANDO_PEDIDO);
    }

    await atualizarFila(filtroOk ? 'progressão da fila' : 'garantindo filtro Móvel');
    if (!rodando) return estado;
    return irPara(E.PROCURANDO_PEDIDO);
  }

  async function passoAguardandoNovoCodigo() {
    esperasSemCodigo++;
    log('Nenhum código maior que ' + progresso.ultimoCodigo + ' disponível na fila (tentativa ' + esperasSemCodigo + ')');
    log('Procurando código > ' + progresso.ultimoCodigo);
    await atualizarFila('aguardando código maior que ' + progresso.ultimoCodigo);
    if (!rodando) return estado;
    return irPara(E.PROCURANDO_PEDIDO);
  }

  async function passoAguardandoPagina() {
    if (!avisoPaginaDado) {
      log('Aguardando a página de PRÉ-PEDIDOS ou de acompanhamento...');
      avisoPaginaDado = true;
    }
    const pagina = await esperarPor(() => {
      const p = paginaAtual();
      return p !== 'OUTRA' ? p : null;
    }, { timeout: 5000 });

    if (!pagina) {
      if (urlDaLista) {
        log('Página fora do fluxo — retornando para a fila de pré-pedidos');
        return irPara(E.RETORNANDO_FILA);
      }
      return estado;
    }
    avisoPaginaDado = false;
    if (pagina === 'ACOMPANHAMENTO') {
      const codigo = codigoDaUrl();
      const titulo = lerTituloAcompanhamento();
      const codigoReal = codigo != null ? codigo : (titulo ? titulo.codigo : null);
      if (codigoReal != null && !jaTratado(codigoReal) && (!alvo || alvo.codigo === codigoReal)) {
        alvo = alvo || { codigo: codigoReal, transformarClicado: false, simClicado: false };
        return irPara(E.VALIDANDO_PEDIDO);
      }
      return irPara(E.RETORNANDO_FILA);
    }
    return irPara(E.PROCURANDO_PEDIDO);
  }

  /* ============================ LAÇO PRINCIPAL ============================ */

  async function executarPasso() {
    switch (estado) {
      case E.PROCURANDO_PEDIDO:      return passoProcurandoPedido();
      case E.VALIDANDO_LINHA:        return passoValidandoLinha();
      case E.ABRINDO_ACOMPANHAMENTO: return passoAbrindoAcompanhamento();
      case E.VALIDANDO_PEDIDO:       return passoValidandoPedido();
      case E.VALIDANDO_STATUS:       return passoValidandoStatus();
      case E.TRANSFORMANDO:          return passoTransformando();
      case E.CONFIRMANDO:            return passoConfirmando();
      case E.CONCLUIDO:              return passoConcluido();
      case E.BLOQUEADO:              return passoBloqueado();
      case E.RETORNANDO_FILA:        return passoRetornandoFila();
      case E.ATUALIZANDO_FILA:       return passoAtualizandoFila();
      case E.AGUARDANDO_NOVO_CODIGO: return passoAguardandoNovoCodigo();
      case E.AGUARDANDO_PAGINA:      return passoAguardandoPagina();
      default:                       return irPara(E.AGUARDANDO_PAGINA);
    }
  }

  async function motor() {
    if (motorAtivo) return;
    motorAtivo = true;
    let rapidas = 0;
    let marcaTempo = Date.now();
    try {
      while (rodando) {
        manterControle();
        if (ESTADOS_OCIOSOS.indexOf(estado) >= 0 && paginaAtual() === 'OUTRA') {
          irPara(E.AGUARDANDO_PAGINA);
        }
        await executarPasso();

        // proteção contra laço apertado (nunca deve acontecer, mas é barato)
        if (Date.now() - marcaTempo < 1000) {
          if (++rapidas > 60) {
            aviso('Muitas transições em sequência — aplicando pausa de segurança de 250 ms');
            await sleep(250);
            rapidas = 0;
            marcaTempo = Date.now();
          }
        } else {
          rapidas = 0;
          marcaTempo = Date.now();
        }
        await sleep(0);
      }
    } catch (e) {
      erro('Falha no motor da automação:', e && e.message ? e.message : e);
    } finally {
      motorAtivo = false;
      atualizarNotificacao();
    }
  }

  /* ============================== CONTROLES =============================== */

  async function iniciar(config) {
    aplicarConfig(config);

    if (rodando) {
      log('Automação já está em execução');
      return;
    }

    const geracao = ++geracaoInicio;
    paradaSolicitada = false;
    // Um "parar" recebido durante a partida cancela a partida.
    const cancelado = () => paradaSolicitada || geracao !== geracaoInicio;

    const pagina = paginaAtual();
    if (pagina === 'OUTRA') {
      const apareceu = await esperarPor(() => (paginaAtual() !== 'OUTRA' ? true : null), { timeout: 5000 });
      if (cancelado()) { log('Partida cancelada pelo usuário'); return; }
      if (!apareceu) {
        erro('A automação só pode ser iniciada na página de PRÉ-PEDIDOS ou na tela de acompanhamento');
        atualizarNotificacao('Automação: PÁGINA INCORRETA');
        return;
      }
    }

    const dono = await assumirControle();
    if (cancelado()) {
      log('Partida cancelada pelo usuário');
      liberarControle();
      return;
    }
    if (!dono) {
      atualizarNotificacao('Automação: OUTRA ABA NO CONTROLE');
      return;
    }

    rodando = true;
    avisoPaginaDado = false;
    esperasSemCodigo = 0;
    try { chrome.storage.sync.set({ isRunning: true }); } catch (e) {}

    log('=== Automação INICIADA (v' + VERSAO + ') ===');
    log('Intervalo de atualização: ' + CONFIG.refreshInterval + ' ms | Tempo limite de validação: ' + CONFIG.validationTimeout + ' ms');
    log('Último código processado/bloqueado: ' + (progresso.ultimoCodigo || 'nenhum'));

    irPara(paginaAtual() === 'ACOMPANHAMENTO' ? E.AGUARDANDO_PAGINA : E.PROCURANDO_PEDIDO);
    atualizarNotificacao();
    motor();
  }

  function parar() {
    paradaSolicitada = true;
    geracaoInicio++;                 // cancela qualquer partida em andamento

    if (!rodando) {
      try { chrome.storage.sync.set({ isRunning: false }); } catch (e) {}
      liberarControle();
      irPara(E.IDLE);
      atualizarNotificacao();
      return;
    }
    rodando = false;
    alvo = null;
    atualizandoFila = false;
    navegando = false;
    irPara(E.IDLE);
    try { chrome.storage.sync.set({ isRunning: false }); } catch (e) {}
    salvarProgresso(true);
    liberarControle();
    log('=== Automação PARADA ===');
    atualizarNotificacao();
  }

  function zerarProgresso() {
    progresso.ultimoCodigo = 0;
    progresso.transformados.clear();
    progresso.bloqueados.clear();
    progresso.tentativas = Object.create(null);
    esperasSemCodigo = 0;
    salvarProgresso(true);
    log('Progresso zerado — a fila voltará a considerar todos os códigos');
  }

  /* ============================ INICIALIZAÇÃO ============================= */

  function documentoRelevante() {
    return paginaAtual() !== 'OUTRA';
  }

  async function inicializar() {
    injetarEstilos();

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        chrome.runtime.sendMessage({ action: 'whoami' }, (r) => {
          if (chrome.runtime.lastError) return;
          if (r && r.tabId != null) meuTabId = r.tabId;
        });
      } catch (e) {}
    }

    await carregarConfig();
    await carregarProgresso();

    // espera o AngularJS montar a tela antes de decidir qualquer coisa
    await esperarPor(() => (documentoRelevante() ? true : null), { timeout: 15000 });
    if (!documentoRelevante()) return;   // frame irrelevante: não cria badge nem escuta nada

    criarNotificacao();
    atualizarNotificacao();

    let estadoSalvo = {};
    try {
      estadoSalvo = await new Promise((res) => chrome.storage.sync.get(['isRunning'], res));
    } catch (e) {}

    if (estadoSalvo && estadoSalvo.isRunning) {
      log('Estado anterior indica automação ativa — retomando');
      iniciar(null);
    } else {
      log('Automação carregada (v' + VERSAO + ') e aguardando comando');
    }
  }

  /* ========================= MENSAGENS / STORAGE ========================== */

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((mensagem, remetente, responder) => {
      switch (mensagem && mensagem.action) {
        case 'startAutomation':
          if (documentoRelevante()) iniciar(mensagem.config);
          break;
        case 'stopAutomation':
          parar();
          break;
        case 'updateConfig':
          aplicarConfig(mensagem.config);
          log('Configurações atualizadas — intervalo de atualização: ' + CONFIG.refreshInterval + ' ms');
          break;
        case 'resetProgress':
          zerarProgresso();
          break;
        case 'getState':
          if (responder) {
            responder({
              rodando: rodando, estado: estado, ultimoCodigo: progresso.ultimoCodigo,
              transformados: progresso.transformados.size, bloqueados: progresso.bloqueados.size
            });
            return true;
          }
          break;
      }
      if (responder) responder({ success: true });
      return true;
    });
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((mudancas, area) => {
      if (area === 'sync') {
        const c = {};
        ['refreshInterval', 'validationTimeout', 'requireStatus'].forEach((k) => {
          if (mudancas[k]) c[k] = mudancas[k].newValue;
        });
        if (Object.keys(c).length) aplicarConfig(c);
      }
      // o popup apagou o progresso: limpa também o que está em memória
      if (area === 'local' && mudancas[CHAVE_PROGRESSO] && mudancas[CHAVE_PROGRESSO].newValue === undefined) {
        progresso.ultimoCodigo = 0;
        progresso.transformados.clear();
        progresso.bloqueados.clear();
        progresso.tentativas = Object.create(null);
        esperasSemCodigo = 0;
        log('Progresso zerado pelo painel da extensão');
      }
    });
  }

  window.addEventListener('beforeunload', () => { if (rodando) salvarProgresso(true); });

  // API interna usada pelos testes automatizados
  window.__INFO2B__ = {
    versao: VERSAO,
    iniciar: iniciar,
    parar: parar,
    zerarProgresso: zerarProgresso,
    estado: () => estado,
    progresso: () => ({
      ultimoCodigo: progresso.ultimoCodigo,
      transformados: Array.from(progresso.transformados),
      bloqueados: Array.from(progresso.bloqueados)
    }),
    config: CONFIG,
    interno: {
      normalizar, lerLinhas, escolherProximo, lerStatusAtual, encontrarFiltroTipo,
      encontrarBotaoTransformar, encontrarBotaoSim, encontrarBotaoAcompanhamento,
      lerTituloAcompanhamento, paginaAtual, statusBloqueado
    }
  };

  inicializar();
})();
