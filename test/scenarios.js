/* Casos de teste obrigatórios do motor de automação (rodam em jsdom). */
const { criarApp, espera, ate } = require('./harness');

const CONFIG = { refreshInterval: 150, validationTimeout: 900, requireStatus: false };

let falhas = 0;
let total = 0;

function ok(condicao, descricao, extra) {
  total++;
  if (condicao) {
    console.log('   ✔ ' + descricao);
  } else {
    falhas++;
    console.log('   ✘ ' + descricao + (extra ? '  → ' + extra : ''));
  }
}

async function iniciar(app, config) {
  app.carregarExtensao();
  await espera(120);
  app.enviarMensagem({ action: 'startAutomation', config: Object.assign({}, CONFIG, config || {}) });
}

function encerrar(app) {
  app.enviarMensagem({ action: 'stopAutomation' });
  try { app.window.close(); } catch (e) {}
}

const P = (codigo, tipo, status, statusFila) => ({
  codigo, tipo, status, statusFila: statusFila !== undefined ? statusFila : status
});

/* ------------------------------------------------------------------ */
async function cenario1() {
  console.log('\nCENÁRIO 1 — 262614 CANCELADO, 262615 válido, 262616 Fixo');
  const app = criarApp({
    pedidos: [
      P(262614, 'Móvel', 'CANCELADO'),
      P(262615, 'Móvel', 'AGUARDANDO VALIDAÇÃO BKO'),
      P(262616, 'Fixo', 'AGUARDANDO VALIDAÇÃO BKO')
    ],
    mostrarLogs: true
  });
  await iniciar(app);
  await ate(() => app.transformados.length > 0, 10000, 'transformação de 262615');
  await espera(300);

  ok(app.transformados.join() === '262615', 'transformou apenas 262615', 'transformados=' + app.transformados.join());
  ok(!app.cliquesSim[262614], 'nunca clicou em "Sim" para o CANCELADO 262614');
  ok(!app.cliquesTransformar[262614], 'nunca clicou em "Transformar" para o CANCELADO 262614');
  ok(app.aberturas.indexOf(262616) < 0, 'nunca abriu o pedido Fixo 262616');
  ok(app.atualizacoes.length > 0, 'atualizou a fila pelo filtro Móvel');
  ok(!app.cliqueErrado, 'não clicou em nenhum outro ícone da linha');
  encerrar(app);
}

/* ------------------------------------------------------------------ */
async function cenario1b() {
  console.log('\nCENÁRIO 1b — mesmo caso, mas o CANCELADO só aparece na tela de acompanhamento');
  const app = criarApp({
    pedidos: [
      P(262614, 'Móvel', 'CANCELADO', ''),          // fila não mostra o status
      P(262615, 'Móvel', 'AGUARDANDO VALIDAÇÃO BKO', ''),
      P(262616, 'Fixo', 'AGUARDANDO VALIDAÇÃO BKO', '')
    ]
  });
  await iniciar(app);
  await ate(() => app.transformados.length > 0, 10000, 'transformação de 262615');
  await espera(300);

  ok(app.aberturas.indexOf(262614) >= 0, 'abriu 262614 para validar o status');
  ok(!app.cliquesTransformar[262614], 'bloqueou 262614 sem clicar em "Transformar"');
  ok(app.transformados.join() === '262615', 'transformou apenas 262615', 'transformados=' + app.transformados.join());
  ok(app.logs.some((l) => /Status atual: CANCELADO/.test(l)), 'registrou o status CANCELADO no log');
  ok(app.logs.some((l) => /Pedido bloqueado: 262614/.test(l)), 'registrou o bloqueio de 262614');
  encerrar(app);
}

/* ------------------------------------------------------------------ */
async function cenario2() {
  console.log('\nCENÁRIO 2 — 262614 e 262615 válidos (ordem e ausência de duplicidade)');
  const app = criarApp({
    pedidos: [
      P(262614, 'Móvel', 'AGUARDANDO VALIDAÇÃO BKO'),
      P(262615, 'Móvel', 'AGUARDANDO VALIDAÇÃO BKO')
    ]
  });
  await iniciar(app);
  await ate(() => app.transformados.length >= 2, 12000, 'duas transformações');
  await espera(400);

  ok(app.transformados.join() === '262614,262615', 'transformou na ordem 262614 → 262615', app.transformados.join());
  ok(app.cliquesSim[262614] === 1 && app.cliquesSim[262615] === 1, 'clicou uma única vez em "Sim" por pedido');
  ok(app.cliquesTransformar[262614] === 1 && app.cliquesTransformar[262615] === 1, 'clicou uma única vez em "Transformar" por pedido');
  ok(app.transformados.length === 2, 'não repetiu nenhum pedido', app.transformados.join());
  encerrar(app);
}

/* ------------------------------------------------------------------ */
async function cenario3() {
  console.log('\nCENÁRIO 3 — 262614 CANCELADO, 262615 Fixo, 262616 Móvel válido');
  const app = criarApp({
    pedidos: [
      P(262614, 'Móvel', 'CANCELADO'),
      P(262615, 'Fixo', 'AGUARDANDO VALIDAÇÃO BKO'),
      P(262616, 'Móvel', 'AGUARDANDO VALIDAÇÃO BKO')
    ]
  });
  await iniciar(app);
  await ate(() => app.transformados.length > 0, 10000, 'transformação de 262616');
  await espera(300);

  ok(app.transformados.join() === '262616', 'transformou apenas 262616', app.transformados.join());
  ok(app.aberturas.indexOf(262615) < 0, 'nunca abriu o pedido Fixo 262615');
  ok(!app.cliquesSim[262614], 'não transformou o CANCELADO 262614');
  encerrar(app);
}

/* ------------------------------------------------------------------ */
async function cenario4() {
  console.log('\nCENÁRIO 4 — após o CANCELADO só existem códigos menores/iguais');
  let injetado = false;
  const app = criarApp({
    pedidos: [P(262614, 'Móvel', 'CANCELADO')],
    aoAtualizar(a) {
      // depois do bloqueio, a fila passa a mostrar um pedido ANTIGO e válido
      if (!a.pedidos.some((p) => p.codigo === 262613)) {
        a.pedidos.unshift(P(262613, 'Móvel', 'AGUARDANDO VALIDAÇÃO BKO'));
      }
    }
  });
  await iniciar(app);
  await ate(() => app.atualizacoes.length >= 5, 10000, 'ciclos de atualização');

  ok(app.transformados.length === 0, 'não transformou nenhum pedido', app.transformados.join());
  ok(app.aberturas.indexOf(262613) < 0, 'não voltou para o código antigo 262613');
  ok(app.aberturas.filter((c) => c === 262614).length <= 1, 'não reabriu 262614 em laço');
  ok(app.logs.some((l) => /Procurando código > 262614/.test(l)), 'registrou a busca por código maior que 262614');

  const intervalos = [];
  for (let i = 1; i < app.atualizacoes.length; i++) intervalos.push(app.atualizacoes[i] - app.atualizacoes[i - 1]);
  const menor = Math.min.apply(null, intervalos);
  ok(menor >= CONFIG.refreshInterval - 40, 'respeitou o intervalo mínimo entre atualizações (menor=' + menor + 'ms)');

  // agora aparece um código MAIOR: precisa processar
  app.pedidos.push(P(262615, 'Móvel', 'AGUARDANDO VALIDAÇÃO BKO'));
  await ate(() => app.transformados.length === 1, 10000, 'transformação do código novo');
  ok(app.transformados.join() === '262615', 'transformou o novo código 262615 assim que apareceu', app.transformados.join());
  encerrar(app);
}

/* ------------------------------------------------------------------ */
async function cenario5() {
  console.log('\nCENÁRIO 5 — CANCELADO em outra linha não interfere no pedido atual');
  const app = criarApp({
    pedidos: [
      P(262615, 'Móvel', 'AGUARDANDO VALIDAÇÃO BKO', ''),  // sem status na fila
      P(262616, 'Móvel', 'CANCELADO', 'CANCELADO'),        // cancelado visível em outra linha
      P(262617, 'Móvel', 'AGUARDANDO VALIDAÇÃO BKO', '')
    ]
  });
  await iniciar(app);
  await ate(() => app.transformados.length >= 2, 14000, 'duas transformações');
  await espera(400);

  ok(app.transformados.join() === '262615,262617', 'transformou 262615 e 262617, pulando o CANCELADO 262616', app.transformados.join());
  ok(!app.cliquesSim[262616], 'nunca clicou em "Sim" no pedido CANCELADO de outra linha');
  encerrar(app);
}

/* ------------------------------------------------------------------ */
async function cenario6() {
  console.log('\nCENÁRIO 6 — status demora para carregar');
  const app = criarApp({
    pedidos: [P(262614, 'Móvel', 'AGUARDANDO VALIDAÇÃO BKO', '')],
    atrasoStatus: 500
  });
  await iniciar(app);
  await ate(() => app.transformados.length === 1, 10000, 'transformação após o status carregar');

  ok(app.cliqueTransformarEm[262614] >= app.statusProntoEm[262614],
    'só clicou em "Transformar" depois que o status ficou legível',
    'clique=' + app.cliqueTransformarEm[262614] + ' status=' + app.statusProntoEm[262614]);
  ok(app.transformados.join() === '262614', 'transformou o pedido válido', app.transformados.join());
  encerrar(app);

  console.log('CENÁRIO 6b — status demorado E cancelado');
  const app2 = criarApp({
    pedidos: [P(262614, 'Móvel', 'CANCELADO', ''), P(262615, 'Móvel', 'AGUARDANDO VALIDAÇÃO BKO', '')],
    atrasoStatus: 500
  });
  await iniciar(app2);
  await ate(() => app2.transformados.length === 1, 12000, 'transformação de 262615');
  ok(!app2.cliquesTransformar[262614], 'não assumiu que o status ausente era válido (262614 bloqueado)');
  ok(app2.transformados.join() === '262615', 'seguiu para o próximo pedido válido', app2.transformados.join());
  encerrar(app2);
}

/* ------------------------------------------------------------------ */
async function cenario7() {
  console.log('\nCENÁRIO 7 — botão "Transformar" aparece antes do status');
  const app = criarApp({
    pedidos: [P(262614, 'Móvel', 'CANCELADO', ''), P(262615, 'Móvel', 'AGUARDANDO VALIDAÇÃO BKO', '')],
    atrasoStatus: 600,
    botaoAntesDoStatus: true
  });
  await iniciar(app);
  await ate(() => app.transformados.length === 1, 12000, 'transformação de 262615');
  await espera(200);

  ok(!app.cliquesTransformar[262614], 'não clicou no botão disponível antes da validação (262614 CANCELADO)');
  ok(app.cliqueTransformarEm[262615] >= app.statusProntoEm[262615], 'no pedido válido, clicou só após validar o status');
  ok(app.transformados.join() === '262615', 'transformou apenas o pedido válido', app.transformados.join());
  encerrar(app);
}

/* ------------------------------------------------------------------ */
async function cenarioIcones() {
  console.log('\nEXTRA — identificação do ícone da linha (pasta, ng-click, href e posição)');
  for (const modo of ['pasta', 'ngclick', 'href', 'posicao']) {
    const app = criarApp({
      pedidos: [P(262614, 'Móvel', 'AGUARDANDO VALIDAÇÃO BKO'), P(262615, 'Móvel', 'CANCELADO')],
      modoIcone: modo
    });
    await iniciar(app);
    await ate(() => app.transformados.length === 1, 10000, 'transformação com modo ' + modo);
    ok(app.transformados.join() === '262614' && !app.cliqueErrado,
      'modo "' + modo + '": abriu a linha certa pelo segundo ícone', app.transformados.join());
    encerrar(app);
  }
}

/* ------------------------------------------------------------------ */
async function cenarioNavegacao() {
  console.log('\nEXTRA — o sistema navega para o pedido após confirmar');
  const app = criarApp({
    pedidos: [P(262614, 'Móvel', 'AGUARDANDO VALIDAÇÃO BKO'), P(262615, 'Móvel', 'AGUARDANDO VALIDAÇÃO BKO')],
    navegarAoTransformar: true
  });
  await iniciar(app);
  await ate(() => app.transformados.length >= 2, 14000, 'duas transformações com navegação');
  ok(app.transformados.join() === '262614,262615', 'voltou para a fila e processou o próximo', app.transformados.join());
  encerrar(app);
}

/* ------------------------------------------------------------------ */
async function cenarioExigirStatus() {
  console.log('\nEXTRA — opção "Exigir status definido"');
  const app = criarApp({ pedidos: [P(262614, 'Móvel', 'Não informado', ''), P(262615, 'Móvel', 'AGUARDANDO VALIDAÇÃO BKO', '')] });
  await iniciar(app, { requireStatus: true });
  await ate(() => app.transformados.length === 1, 12000, 'transformação de 262615');
  ok(!app.cliquesSim[262614], 'bloqueou o pedido sem status definido');
  ok(app.transformados.join() === '262615', 'seguiu para o pedido com status', app.transformados.join());
  encerrar(app);

  const app2 = criarApp({ pedidos: [P(262614, 'Móvel', 'Não informado', '')] });
  await iniciar(app2, { requireStatus: false });
  await ate(() => app2.transformados.length === 1, 10000, 'transformação com a opção desligada');
  ok(app2.transformados.join() === '262614', 'com a opção desligada, transformou normalmente', app2.transformados.join());
  encerrar(app2);
}

/* ------------------------------------------------------------------ */
async function cenarioCadencia() {
  console.log('\nEXTRA — o intervalo configurado realmente muda a velocidade (grade que não muta)');
  const medidos = {};
  for (const intervalo of [500, 1500]) {
    const app = criarApp({
      pedidos: [P(262614, 'Móvel', 'CANCELADO')],   // fila sem código maior: só atualiza
      gradeEstatica: true
    });
    // tempo limite de validação no padrão de produção: não pode influenciar a cadência
    await iniciar(app, { refreshInterval: intervalo, validationTimeout: 8000 });
    await ate(() => app.atualizacoes.length >= 6, 40000, 'ciclos de atualização com ' + intervalo + 'ms');

    const periodos = [];
    for (let i = 2; i < app.atualizacoes.length; i++) periodos.push(app.atualizacoes[i] - app.atualizacoes[i - 1]);
    periodos.sort((a, b) => a - b);
    const mediana = periodos[Math.floor(periodos.length / 2)];
    medidos[intervalo] = mediana;

    ok(mediana >= intervalo * 0.85 && mediana <= intervalo * 1.45,
      'intervalo ' + intervalo + 'ms → cadência medida ' + mediana + 'ms',
      'períodos=' + periodos.join(','));
    encerrar(app);
  }
  ok(medidos[1500] > medidos[500] * 2,
    'cadência de 1500ms é proporcionalmente mais lenta que a de 500ms',
    JSON.stringify(medidos));
}

/* ------------------------------------------------------------------ */
async function cenarioParar() {
  console.log('\nEXTRA — parar a automação interrompe o fluxo');
  const app = criarApp({ pedidos: [P(262614, 'Móvel', 'AGUARDANDO VALIDAÇÃO BKO')] });
  await iniciar(app);
  app.enviarMensagem({ action: 'stopAutomation' });
  await espera(1500);
  ok(app.transformados.length === 0, 'nada foi transformado após o comando de parada', app.transformados.join());
  try { app.window.close(); } catch (e) {}
}

(async function () {
  const inicio = Date.now();
  try {
    await cenario1();
    await cenario1b();
    await cenario2();
    await cenario3();
    await cenario4();
    await cenario5();
    await cenario6();
    await cenario7();
    await cenarioIcones();
    await cenarioNavegacao();
    await cenarioExigirStatus();
    await cenarioCadencia();
    await cenarioParar();
  } catch (e) {
    falhas++;
    console.log('\n!! Erro na execução dos testes: ' + (e && e.stack ? e.stack : e));
  }
  console.log('\n==============================');
  console.log('Verificações: ' + total + ' | falhas: ' + falhas + ' | tempo: ' + ((Date.now() - inicio) / 1000).toFixed(1) + 's');
  process.exit(falhas ? 1 : 0);
})();
