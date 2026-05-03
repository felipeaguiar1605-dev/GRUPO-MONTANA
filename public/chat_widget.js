/**
 * Montana ERP - Widget de Chat IA (Claude Haiku 4.5)
 * Injetado em todas as paginas via index.html
 */
(function() {
  if (window.__iaWidgetLoaded) return;
  window.__iaWidgetLoaded = true;

  const state = { aberto: false, historico: [], loading: false };

  // HTML do widget
  const html = `
    <div id="ia-btn" style="position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:28px;background:#8b5cf6;color:white;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.2);font-size:24px;z-index:9998;transition:transform .2s" title="Assistente IA (Claude)">🤖</div>

    <div id="ia-panel" style="position:fixed;bottom:90px;right:20px;width:380px;max-width:calc(100vw - 40px);height:520px;max-height:calc(100vh - 140px);background:white;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.15);display:none;flex-direction:column;z-index:9999;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
      <div style="background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:white;padding:14px 16px;display:flex;align-items:center;gap:10px">
        <div style="width:36px;height:36px;background:rgba(255,255,255,.2);border-radius:18px;display:flex;align-items:center;justify-content:center;font-size:18px">🤖</div>
        <div style="flex:1">
          <div style="font-weight:700;font-size:14px">Assistente Montana</div>
          <div style="font-size:11px;opacity:.85">Claude Haiku 4.5 · Dados em tempo real</div>
        </div>
        <div id="ia-close" style="cursor:pointer;width:28px;height:28px;border-radius:14px;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;font-size:16px">×</div>
      </div>

      <div id="ia-msgs" style="flex:1;overflow-y:auto;padding:14px;background:#f8fafc;display:flex;flex-direction:column;gap:10px">
        <div class="ia-msg-ia" style="background:white;padding:10px 12px;border-radius:12px 12px 12px 4px;max-width:85%;font-size:13px;line-height:1.5;color:#1f2937;border:1px solid #e5e7eb">
          Olá! Sou o assistente financeiro do Montana. Posso responder sobre faturamento, contratos, conciliação, transparência pública. O que precisa?
        </div>
      </div>

      <div style="padding:10px 14px;border-top:1px solid #e5e7eb;display:flex;gap:8px;align-items:center">
        <input id="ia-input" type="text" placeholder="Digite sua pergunta..." style="flex:1;padding:8px 12px;border:1px solid #d1d5db;border-radius:20px;font-size:13px;outline:none" />
        <button id="ia-send" style="width:36px;height:36px;border-radius:18px;background:#8b5cf6;color:white;border:0;cursor:pointer;font-size:16px">➤</button>
      </div>

      <div style="padding:6px 14px;font-size:10px;color:#9ca3af;text-align:center;border-top:1px solid #f3f4f6">
        Dados: faturamento, despesas, contratos e certidões do mês atual
      </div>
    </div>
  `;

  const div = document.createElement('div');
  div.innerHTML = html;
  document.body.appendChild(div);

  const btn = document.getElementById('ia-btn');
  const panel = document.getElementById('ia-panel');
  const close = document.getElementById('ia-close');
  const msgs = document.getElementById('ia-msgs');
  const input = document.getElementById('ia-input');
  const send = document.getElementById('ia-send');

  function toggle() {
    state.aberto = !state.aberto;
    panel.style.display = state.aberto ? 'flex' : 'none';
    if (state.aberto) setTimeout(() => input.focus(), 100);
  }
  btn.onclick = toggle;
  close.onclick = toggle;

  function addMsg(texto, tipo) {
    const d = document.createElement('div');
    if (tipo === 'user') {
      d.style.cssText = 'background:#8b5cf6;color:white;padding:10px 12px;border-radius:12px 12px 4px 12px;max-width:85%;align-self:flex-end;font-size:13px;line-height:1.5';
    } else {
      d.style.cssText = 'background:white;padding:10px 12px;border-radius:12px 12px 12px 4px;max-width:85%;font-size:13px;line-height:1.5;color:#1f2937;border:1px solid #e5e7eb';
    }
    // Markdown básico: **bold** e \n -> <br>
    d.innerHTML = texto
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\n/g, '<br>');
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
  }

  async function enviar() {
    const txt = input.value.trim();
    if (!txt || state.loading) return;
    input.value = '';
    addMsg(txt, 'user');
    state.historico.push({ role: 'user', content: txt });

    // Loading indicator
    const load = document.createElement('div');
    load.id = 'ia-load';
    load.style.cssText = 'color:#9ca3af;font-size:12px;padding:0 12px;font-style:italic';
    load.textContent = '🤔 pensando...';
    msgs.appendChild(load);
    msgs.scrollTop = msgs.scrollHeight;
    state.loading = true;

    try {
      const token = localStorage.getItem('montana_token') || '';
      const empresa = localStorage.getItem('montana_company') || localStorage.getItem('montana_empresa') || 'assessoria';
      const r = await fetch('/api/ia/chat', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'x-company': empresa,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ mensagem: txt, historico: state.historico.slice(-6) }),
      });
      const d = await r.json();
      load.remove();
      if (d.ok && d.resposta) {
        addMsg(d.resposta, 'ia');
        state.historico.push({ role: 'assistant', content: d.resposta });
      } else {
        addMsg('⚠️ ' + (d.erro || d.resposta || 'Erro ao processar'), 'ia');
      }
    } catch (e) {
      load.remove();
      addMsg('❌ Erro de conexão: ' + e.message, 'ia');
    } finally {
      state.loading = false;
      input.focus();
    }
  }

  send.onclick = enviar;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') enviar(); });

  // Hover animation
  btn.addEventListener('mouseenter', () => btn.style.transform = 'scale(1.1)');
  btn.addEventListener('mouseleave', () => btn.style.transform = 'scale(1)');
})();
