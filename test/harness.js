/* Simulador do Info2B (jsdom) usado para testar o motor da automação. */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require(process.env.JSDOM_PATH || 'jsdom');

const CONTENT = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const BASE = 'http://app.info2b.com.br/';

function criarApp(opcoes) {
  const op = Object.assign(
    {
      pedidos: [],
      modoIcone: 'pasta',        // 'pasta' | 'ngclick' | 'posicao'
      atrasoStatus: 0,           // ms até o status aparecer na tela
      botaoAntesDoStatus: false, // botão Transformar visível antes do status
      navegarAoTransformar: false,
      hashInicial: '#!/pre-pedidos'
    },
    opcoes || {}
  );

  const logs = [];
  const vc = new VirtualConsole();
  ['log', 'warn', 'error', 'info'].forEach((nivel) => {
    vc.on(nivel, (...args) => {
      const linha = args.map(String).join(' ');
      logs.push(linha);
      if (op.mostrarLogs) console.log('    ' + linha);
    });
  });

  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: BASE + op.hashInicial,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc
  });
  const { window } = dom;
  const document = window.document;

  const app = {
    window,
    document,
    pedidos: op.pedidos.slice(),
    tiposSelecionados: [],
    atualizacoes: [],            // timestamps de cada atualização da fila
    transformados: [],           // códigos confirmados com "Sim"
    cliquesTransformar: {},      // código -> nº de cliques em "Transformar em Pedido"
    cliquesSim: {},              // código -> nº de cliques em "Sim"
    aberturas: [],               // códigos abertos no acompanhamento
    statusProntoEm: {},          // código -> timestamp em que o status ficou legível
    cliqueTransformarEm: {},     // código -> timestamp do clique
    op
  };

  /* ----------------------------- mock chrome ----------------------------- */
  const dados = { local: {}, sync: {} };
  const ouvintesStorage = [];
  const ouvintesMensagem = [];

  function area(nome) {
    const store = dados[nome];
    return {
      get(chaves, cb) {
        const lista = Array.isArray(chaves) ? chaves : (typeof chaves === 'string' ? [chaves] : Object.keys(chaves || store));
        const saida = {};
        lista.forEach((k) => { if (k in store) saida[k] = store[k]; });
        setTimeout(() => cb && cb(saida), 0);
      },
      set(obj, cb) {
        const mudancas = {};
        Object.keys(obj).forEach((k) => {
          mudancas[k] = { oldValue: store[k], newValue: obj[k] };
          store[k] = obj[k];
        });
        setTimeout(() => {
          ouvintesStorage.forEach((f) => f(mudancas, nome));
          cb && cb();
        }, 0);
      },
      remove(chave, cb) {
        const lista = Array.isArray(chave) ? chave : [chave];
        const mudancas = {};
        lista.forEach((k) => { mudancas[k] = { oldValue: store[k], newValue: undefined }; delete store[k]; });
        setTimeout(() => { ouvintesStorage.forEach((f) => f(mudancas, nome)); cb && cb(); }, 0);
      }
    };
  }

  window.chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(msg, cb) {
        if (msg && msg.action === 'whoami') setTimeout(() => cb && cb({ tabId: 1, frameId: 0 }), 0);
        else setTimeout(() => cb && cb({ success: true }), 0);
      },
      onMessage: { addListener: (f) => ouvintesMensagem.push(f) }
    },
    storage: {
      local: area('local'),
      sync: area('sync'),
      onChanged: { addListener: (f) => ouvintesStorage.push(f) }
    }
  };
  app.enviarMensagem = (msg) => ouvintesMensagem.forEach((f) => f(msg, {}, () => {}));
  app.dados = dados;

  /* --------------------------- renderização SPA -------------------------- */
  function el(tag, attrs, texto) {
    const e = document.createElement(tag);
    Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k]));
    if (texto != null) e.textContent = texto;
    return e;
  }

  function pedidosVisiveis() {
    const tipos = app.tiposSelecionados;
    return app.pedidos.filter((p) => !tipos.length || tipos.indexOf(p.tipo) >= 0);
  }

  function renderLista() {
    document.body.innerHTML = '';
    document.body.appendChild(el('label', { class: 'uppercase titulo-funcionalidade' }, 'PRÉ-PEDIDOS'));

    const tabela = el('table', { class: 'table' });
    const thead = el('thead');

    const trCab = el('tr');
    ['', 'CÓDIGO ▲▼✕', 'TIPO ▲▼🔍✕', 'CNPJ ▲▼✕', 'RAZÃO SOCIAL ▲▼✕', 'CPF ▲▼✕',
     'NOME DA PESSOA FÍSICA ▲▼✕', 'STATUS PERSONALIZADO ATUAL ▲▼🔍✕', 'SISTEMA DA OPERADORA',
     'DATA DE CRIAÇÃO'].forEach((t) => trCab.appendChild(el('th', null, t)));
    thead.appendChild(trCab);

    const trFiltro = el('tr', { class: 'filtros' });
    trFiltro.appendChild(el('td'));
    trFiltro.appendChild(el('td'));                       // filtro texto do CÓDIGO
    const tdTipo = el('td');
    const selTipo = el('select', { multiple: 'multiple', size: '4', 'ng-model': 'filtro.tipo' });
    ['Móvel', 'Fixo', 'VSTI', 'Avançada'].forEach((t) => {
      const o = el('option', { value: t }, t);
      if (app.tiposSelecionados.indexOf(t) >= 0) o.selected = true;
      selTipo.appendChild(o);
    });
    selTipo.addEventListener('change', () => {
      app.tiposSelecionados = Array.prototype.filter.call(selTipo.options, (o) => o.selected).map((o) => o.value);
      atualizarFilaSimulada();
    });
    tdTipo.appendChild(selTipo);
    trFiltro.appendChild(tdTipo);
    for (let i = 0; i < 4; i++) trFiltro.appendChild(el('td'));
    const tdStatus = el('td');
    const selStatus = el('select', { multiple: 'multiple', size: '4', 'ng-model': 'filtro.status' });
    ['AGUARDANDO ADM SECUNDÁRIO', 'AGUARDANDO VALIDAÇÃO BKO', 'CANCELADO', 'LIGAÇÃO DE CDV INAUDÍVEL']
      .forEach((t) => selStatus.appendChild(el('option', { value: t }, t)));
    tdStatus.appendChild(selStatus);
    trFiltro.appendChild(tdStatus);
    trFiltro.appendChild(el('td'));
    trFiltro.appendChild(el('td'));
    thead.appendChild(trFiltro);
    tabela.appendChild(thead);

    const tbody = el('tbody');
    pedidosVisiveis().forEach((p) => tbody.appendChild(montarLinha(p)));
    tabela.appendChild(tbody);
    document.body.appendChild(tabela);
    app.tbody = tbody;
  }

  function montarLinha(p) {
    const tr = el('tr');
    const tdIcones = el('td');

    const icones = ['fa-pencil-square-o', 'fa-folder-open', 'fa-shopping-cart', 'fa-print', 'fa-paperclip'];
    icones.forEach((classe, idx) => {
      const i = el('i', { class: 'fa ' + classe });
      if (idx === 1) {
        if (op.modoIcone === 'ngclick') {
          const w = el('span', { 'ng-click': 'abrirAcompanhamento(item)' });
          w.appendChild(i);
          w.addEventListener('click', () => abrir(p.codigo));
          tdIcones.appendChild(w);
          return;
        }
        if (op.modoIcone === 'href') {
          const a = el('a', { href: '#!/pre-pedidos/acompanhamento/' + p.codigo });
          a.appendChild(i);
          tdIcones.appendChild(a);
          return;
        }
        if (op.modoIcone === 'posicao') i.setAttribute('class', 'fa fa-file-text-o');  // sem "folder"
        i.addEventListener('click', () => abrir(p.codigo));
      } else {
        i.addEventListener('click', () => { app.cliqueErrado = (app.cliqueErrado || 0) + 1; });
      }
      tdIcones.appendChild(i);
    });
    tr.appendChild(tdIcones);

    tr.appendChild(el('td', null, String(p.codigo)));
    tr.appendChild(el('td', null, p.tipo));
    tr.appendChild(el('td', null, '56057889000106'));
    tr.appendChild(el('td', null, '56.057.889 ALESSANDRA CRISTINA MATOS'));
    tr.appendChild(el('td', null, ''));
    tr.appendChild(el('td', null, ''));
    tr.appendChild(el('td', { 'ng-class': "{'cancelado': item.statusPersonalizadoAtual}" }, p.statusFila != null ? p.statusFila : p.status));
    tr.appendChild(el('td', null, 'Não informado'));
    tr.appendChild(el('td', null, '12/03/2026 13:49:09'));
    return tr;
  }

  function abrir(codigo) {
    window.location.hash = '#!/pre-pedidos/acompanhamento/' + codigo;
  }

  function renderAcompanhamento(codigo) {
    const pedido = app.pedidos.find((p) => p.codigo === codigo);
    document.body.innerHTML = '';
    if (!pedido) return;
    app.aberturas.push(codigo);

    document.body.appendChild(el('label', { class: 'uppercase titulo-funcionalidade' },
      'ACOMPANHAMENTO DO PRÉ-PEDIDO ' + codigo + ' (' + pedido.tipo.toUpperCase() + ')'));
    document.body.appendChild(el('label', { class: 'cliente' }, 'CLIENTE: 56057889000106 - ALESSANDRA CRISTINA MATOS'));

    const grupoStatus = el('div', { class: 'form-group' });
    grupoStatus.appendChild(el('label', { for: 'statusAtual' }, 'Status Personalizado Atual'));
    const selStatus = el('select', { id: 'statusAtual', disabled: 'disabled', 'ng-model': 'pedido.statusPersonalizadoAtual' });
    grupoStatus.appendChild(selStatus);
    document.body.appendChild(grupoStatus);

    const grupoNovo = el('div', { class: 'form-group' });
    grupoNovo.appendChild(el('label', { for: 'novoStatus' }, 'Novo Status Personalizado'));
    const selNovo = el('select', { id: 'novoStatus', 'ng-model': 'novoStatusPersonalizado' });
    ['Não informado', 'AGUARDANDO VALIDAÇÃO BKO', 'CANCELADO'].forEach((t, i) => {
      const o = el('option', { value: t }, t);
      if (i === 0) o.selected = true;
      selNovo.appendChild(o);
    });
    grupoNovo.appendChild(selNovo);
    document.body.appendChild(grupoNovo);

    const grupoOperadora = el('div', { class: 'form-group' });
    grupoOperadora.appendChild(el('label', { for: 'operadora' }, 'Sistema da Operadora'));
    const selOp = el('select', { id: 'operadora', 'ng-model': 'sistemaOperadora' });
    selOp.appendChild(el('option', { value: '' }, 'Não informado'));
    selOp.firstChild.selected = true;
    grupoOperadora.appendChild(selOp);
    document.body.appendChild(grupoOperadora);

    const areaAcao = el('div', { class: 'acoes' });
    document.body.appendChild(areaAcao);

    const mostrarBotao = () => {
      areaAcao.innerHTML = '';
      const b = el('button', { class: 'btn btn-warning', 'ng-click': 'exibirTemCerteza = true;' }, 'Transformar em Pedido ⇄');
      b.addEventListener('click', () => {
        app.cliquesTransformar[codigo] = (app.cliquesTransformar[codigo] || 0) + 1;
        app.cliqueTransformarEm[codigo] = Date.now();
        mostrarConfirmacao();
      });
      areaAcao.appendChild(b);
      areaAcao.appendChild(el('button', { class: 'btn btn-default', 'ng-click': 'cancelar()' }, 'CANCELAR'));
      areaAcao.appendChild(el('button', { class: 'btn btn-primary', 'ng-click': 'salvar()' }, 'SALVAR'));
    };

    const mostrarConfirmacao = () => {
      areaAcao.innerHTML = '';
      areaAcao.appendChild(el('label', null, 'Tem certeza que deseja transformar este pré-pedido em pedido?'));
      const sim = el('button', { class: 'btn btn-success', 'ng-click': 'transformarEmPedido()' }, 'Sim');
      sim.addEventListener('click', () => {
        app.cliquesSim[codigo] = (app.cliquesSim[codigo] || 0) + 1;
        app.transformados.push(codigo);
        const alvo = app.pedidos.find((p) => p.codigo === codigo);
        if (alvo) alvo.status = 'TRANSFORMADO';
        if (op.navegarAoTransformar) window.location.hash = '#!/pedidos/' + codigo;
        else { areaAcao.innerHTML = ''; areaAcao.appendChild(el('div', { class: 'alert alert-success' }, 'Pré-pedido transformado com sucesso!')); }
      });
      areaAcao.appendChild(sim);
      const nao = el('button', { class: 'btn btn-danger', 'ng-click': 'exibirTemCerteza = false;' }, 'Não');
      nao.addEventListener('click', () => { app.cliqueNao = (app.cliqueNao || 0) + 1; mostrarBotao(); });
      areaAcao.appendChild(nao);
    };

    const carregarStatus = () => {
      selStatus.appendChild(el('option', { value: pedido.status }, pedido.status));
      selStatus.options[selStatus.options.length - 1].selected = true;
      app.statusProntoEm[codigo] = Date.now();
      if (op.botaoAntesDoStatus) return;   // botão já foi exibido
      mostrarBotao();
    };

    if (op.botaoAntesDoStatus) mostrarBotao();
    // AngularJS ainda não resolveu o ng-model: option "?" como no Angular real
    const vazio = el('option', { value: '? undefined:undefined ?' }, '');
    vazio.selected = true;
    selStatus.appendChild(vazio);

    if (op.atrasoStatus > 0) setTimeout(() => { selStatus.innerHTML = ''; carregarStatus(); }, op.atrasoStatus);
    else { selStatus.innerHTML = ''; carregarStatus(); }
  }

  function atualizarFilaSimulada() {
    app.atualizacoes.push(Date.now());
    if (typeof op.aoAtualizar === 'function') op.aoAtualizar(app);
    if (rotaAtual().tipo === 'LISTA') renderLista();
  }

  function rotaAtual() {
    const h = window.location.hash || '';
    const m = h.match(/#!\/pre-pedidos\/acompanhamento\/(\d+)/);
    if (m) return { tipo: 'ACOMPANHAMENTO', codigo: parseInt(m[1], 10) };
    if (h.indexOf('#!/pre-pedidos') === 0) return { tipo: 'LISTA' };
    return { tipo: 'OUTRA' };
  }

  function renderizar() {
    const r = rotaAtual();
    if (r.tipo === 'LISTA') renderLista();
    else if (r.tipo === 'ACOMPANHAMENTO') renderAcompanhamento(r.codigo);
    else { document.body.innerHTML = ''; document.body.appendChild(el('label', { class: 'uppercase titulo-funcionalidade' }, 'PEDIDO')); }
  }

  window.addEventListener('hashchange', renderizar);
  renderizar();

  app.carregarExtensao = () => { window.eval(CONTENT); };
  app.logs = logs;
  app.rotaAtual = rotaAtual;
  app.renderizar = renderizar;
  return app;
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function ate(condicao, limite, rotulo) {
  const fim = Date.now() + limite;
  while (Date.now() < fim) {
    if (condicao()) return true;
    await espera(25);
  }
  throw new Error('Tempo esgotado esperando: ' + (rotulo || 'condição'));
}

module.exports = { criarApp, espera, ate };
