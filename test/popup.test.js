/* Testes do painel (popup) — cobrem o campo "Intervalo de atualização". */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(process.env.JSDOM_PATH || 'jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
const JS = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');

let falhas = 0, total = 0;
function ok(condicao, descricao, extra) {
  total++;
  if (condicao) console.log('   ✔ ' + descricao);
  else { falhas++; console.log('   ✘ ' + descricao + (extra ? '  → ' + extra : '')); }
}
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function abrirPopup(opcoes) {
  const op = opcoes || {};
  const dom = new JSDOM(HTML, { url: 'chrome-extension://teste/popup.html', runScripts: 'outside-only' });
  const { window } = dom;
  const dados = { local: Object.assign({}, op.local), sync: Object.assign({}, op.sync) };
  const ouvintes = [];
  const enviadas = [];

  function area(nome) {
    const store = dados[nome];
    return {
      get(chaves, cb) {
        const lista = Array.isArray(chaves) ? chaves : [chaves];
        const saida = {};
        lista.forEach((k) => { if (k in store) saida[k] = store[k]; });
        setTimeout(() => cb && cb(saida), nome === 'local' ? 0 : (op.atrasoSync || 0));
      },
      set(obj, cb) {
        // sync pode falhar (cota/sem conta): o painel não pode depender dele
        if (nome === 'sync' && op.syncFalha) {
          setTimeout(() => { window.chrome.runtime.lastError = { message: 'QUOTA_BYTES' }; if (cb) cb(); window.chrome.runtime.lastError = undefined; }, 0);
          return;
        }
        const mud = {};
        Object.keys(obj).forEach((k) => { mud[k] = { oldValue: store[k], newValue: obj[k] }; store[k] = obj[k]; });
        setTimeout(() => { ouvintes.forEach((f) => f(mud, nome)); if (cb) cb(); }, 0);
      },
      remove(chave, cb) { delete store[chave]; setTimeout(() => cb && cb(), 0); }
    };
  }

  window.chrome = {
    runtime: { lastError: undefined },
    tabs: { query: (q, cb) => setTimeout(() => cb([{ id: 1 }]), 0), sendMessage: (id, msg, cb) => { enviadas.push(msg); if (cb) cb({}); } },
    storage: { local: area('local'), sync: area('sync'), onChanged: { addListener: (f) => ouvintes.push(f) } }
  };

  // espera o carregamento nativo do documento para não registrar o script duas vezes
  await new Promise((r) => {
    if (window.document.readyState === 'loading') window.addEventListener('DOMContentLoaded', () => setTimeout(r, 0), { once: true });
    else setTimeout(r, 0);
  });

  window.eval(JS);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  return { window, doc: window.document, dados, enviadas, fechar: () => { try { window.close(); } catch (e) {} } };
}

const campo = (p, id) => p.doc.getElementById(id);
const clicar = (p, id) => campo(p, id).dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
function digitar(p, id, texto) {
  const el = campo(p, id);
  el.value = texto;
  el.dispatchEvent(new p.window.Event('input', { bubbles: true }));
}

(async function () {
  console.log('\nPOPUP — salvar o intervalo de atualização');
  {
    const p = await abrirPopup({});
    await espera(30);
    digitar(p, 'refresh-interval', '500');
    clicar(p, 'save-settings');
    await espera(60);

    ok(campo(p, 'refresh-interval').value === '500', 'o campo continua com 500 depois de salvar', 'valor=' + campo(p, 'refresh-interval').value);
    ok(p.dados.local.refreshInterval === 500, 'gravou 500 no storage local', JSON.stringify(p.dados.local));
    ok(p.dados.sync.refreshInterval === 500, 'espelhou 500 no storage sync');
    const msg = p.enviadas.filter((m) => m.action === 'updateConfig').pop();
    ok(msg && msg.config.refreshInterval === 500, 'avisou o content script com 500', JSON.stringify(msg));
    ok(/Salvo: 500 ms/.test(campo(p, 'save-settings').textContent), 'confirmou o valor realmente gravado no botão', campo(p, 'save-settings').textContent);
    p.fechar();
  }

  console.log('\nPOPUP — reabrir o painel mantém o valor salvo');
  {
    const p = await abrirPopup({ local: { refreshInterval: 500, validationTimeout: 8000, requireStatus: false } });
    await espera(40);
    ok(campo(p, 'refresh-interval').value === '500', 'reabriu mostrando 500', campo(p, 'refresh-interval').value);
    p.fechar();
  }

  console.log('\nPOPUP — valor inválido não vira 1000 silenciosamente');
  {
    const p = await abrirPopup({ local: { refreshInterval: 500, validationTimeout: 8000 } });
    await espera(40);
    // <input type=number> devolve "" quando o conteúdo não é um número válido
    digitar(p, 'refresh-interval', '');
    clicar(p, 'save-settings');
    await espera(60);

    ok(campo(p, 'refresh-interval').value === '500', 'restaurou o último valor salvo (500), não o padrão 1000', campo(p, 'refresh-interval').value);
    ok(p.dados.local.refreshInterval === 500, 'não gravou o padrão por cima', JSON.stringify(p.dados.local));
    ok(/não salvo/.test(campo(p, 'save-settings').textContent), 'avisou que não salvou', campo(p, 'save-settings').textContent);
    p.fechar();
  }

  console.log('\nPOPUP — leitura lenta do storage não apaga o que foi digitado');
  {
    const p = await abrirPopup({ sync: { refreshInterval: 1000 }, atrasoSync: 120 });
    digitar(p, 'refresh-interval', '500');     // usuário digita antes da leitura terminar
    await espera(200);
    ok(campo(p, 'refresh-interval').value === '500', 'manteve os 500 digitados', campo(p, 'refresh-interval').value);
    p.fechar();
  }

  console.log('\nPOPUP — falha do storage sync não impede salvar');
  {
    const p = await abrirPopup({ syncFalha: true });
    await espera(30);
    digitar(p, 'refresh-interval', '500');
    clicar(p, 'save-settings');
    await espera(80);
    ok(p.dados.local.refreshInterval === 500, 'gravou em local mesmo com o sync falhando', JSON.stringify(p.dados.local));
    ok(campo(p, 'refresh-interval').value === '500', 'campo permanece em 500');
    p.fechar();
  }

  console.log('\nPOPUP — iniciar a automação usa o valor do formulário');
  {
    const p = await abrirPopup({});
    await espera(30);
    digitar(p, 'refresh-interval', '500');
    clicar(p, 'start-btn');
    await espera(60);
    const msg = p.enviadas.filter((m) => m.action === 'startAutomation').pop();
    ok(msg && msg.config.refreshInterval === 500, 'enviou startAutomation com 500', JSON.stringify(msg));
    ok(p.dados.local.refreshInterval === 500, 'gravou 500 antes de iniciar');
    p.fechar();
  }

  console.log('\n==============================');
  console.log('Popup — verificações: ' + total + ' | falhas: ' + falhas);
  process.exit(falhas ? 1 : 0);
})();
