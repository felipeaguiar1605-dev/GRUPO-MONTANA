/**
 * Montana ERP — Integração Banco do Brasil
 * Painel de configuração + sincronização de extrato via API BB
 * Suporte a múltiplas contas por empresa
 */

let _bbPainelAberto = false;

// ── Botão flutuante BB ────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  const btn = document.createElement('div');
  btn.id = 'bb-fab';
  btn.title = 'Banco do Brasil — Sync Extrato';
  btn.onclick = bbTogglePanel;
  btn.style.cssText = `
    position:fixed;bottom:148px;right:20px;width:48px;height:48px;
    background:linear-gradient(135deg,#1a3a6b,#f9a825);
    border-radius:50%;display:flex;align-items:center;justify-content:center;
    cursor:pointer;z-index:9997;box-shadow:0 4px 16px rgba(0,0,0,.25);
    font-size:22px;user-select:none;transition:transform .15s;
  `;
  btn.textContent = '🏦';
  btn.onmouseenter = () => btn.style.transform = 'scale(1.1)';
  btn.onmouseleave = () => btn.style.transform = 'scale(1)';
  document.body.appendChild(btn);
});

// ── Toggle painel ─────────────────────────────────────────────────────────────
function bbTogglePanel() {
  const painel = document.getElementById('bb-painel');
  if (!painel) { _bbCriarPainel(); return; }
  _bbPainelAberto = !_bbPainelAberto;
  painel.style.display = _bbPainelAberto ? 'flex' : 'none';
  if (_bbPainelAberto) bbCarregarStatus();
}

// ── Criar painel ──────────────────────────────────────────────────────────────
function _bbCriarPainel() {
  _bbPainelAberto = true;
  const div = document.createElement('div');
  div.id = 'bb-painel';
  div.style.cssText = `
    position:fixed;bottom:80px;right:80px;width:460px;max-height:90vh;
    background:#fff;border-radius:16px;
    box-shadow:0 8px 40px rgba(0,0,0,.2);
    display:flex;flex-direction:column;z-index:9998;overflow:hidden;
    border:2px solid #f9a825;
  `;
  div.innerHTML = `
    <!-- Header -->
    <div style="background:linear-gradient(135deg,#1a3a6b 0%,#2563eb 60%,#f9a825 100%);
                padding:14px 18px;display:flex;align-items:center;justify-content:space-between">
      <div>
        <div style="color:#fff;font-weight:800;font-size:14px">🏦 Banco do Brasil — Extrato API</div>
        <div style="color:rgba(255,255,255,.75);font-size:11px" id="bb-empresa-label">Empresa atual</div>
      </div>
      <button onclick="document.getElementById('bb-painel').style.display='none';_bbPainelAberto=false"
              style="background:rgba(255,255,255,.2);border:none;border-radius:8px;
                     color:#fff;padding:4px 10px;cursor:pointer;font-size:14px">✕</button>
    </div>

    <!-- Status bar -->
    <div id="bb-status-bar"
         style="padding:9px 16px;font-size:12px;color:#64748b;
                border-bottom:1px solid #f1f5f9;background:#f8fafc">
      Verificando…
    </div>

    <!-- Contas configuradas -->
    <div id="bb-contas-lista" style="display:none;padding:10px 16px;background:#f0fdf4;
         border-bottom:1px solid #bbf7d0;font-size:11px"></div>

    <!-- Body -->
    <div style="padding:16px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:14px">

      <!-- Credenciais -->
      <details id="bb-details-config">
        <summary style="font-size:12px;font-weight:700;color:#1a3a6b;cursor:pointer;padding:4px 0">
          ⚙️ Credenciais API (developers.bb.com.br)
        </summary>
        <div style="display:grid;gap:8px;margin-top:10px">
          <div>
            <label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">AMBIENTE</label>
            <select id="bb-ambiente"
                    onchange="document.getElementById('bb-cert-area').style.display=this.value==='producao'?'flex':'none'"
                    style="width:100%;padding:7px 10px;border:1px solid #e2e8f0;border-radius:8px;font-size:12px">
              <option value="sandbox">🧪 Sandbox — dados fictícios</option>
              <option value="homologacao">🔬 Homologação — credenciais de teste</option>
              <option value="producao" selected>🔒 Produção — dados reais</option>
            </select>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <div>
              <label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">AGÊNCIA (sem dígito)</label>
              <input id="bb-agencia" type="text" placeholder="Ex: 1505"
                     style="width:100%;padding:7px 10px;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;box-sizing:border-box">
            </div>
            <div>
              <label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">CONTA PRINCIPAL</label>
              <input id="bb-conta" type="text" placeholder="Ex: 1090437"
                     style="width:100%;padding:7px 10px;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;box-sizing:border-box">
            </div>
          </div>
          <div>
            <label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">APP KEY (gw-app-key)</label>
            <input id="bb-app-key" type="text" placeholder="Ex: 4072a379c90e..."
                   style="width:100%;padding:7px 10px;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;box-sizing:border-box">
          </div>
          <div>
            <label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">CLIENT ID</label>
            <input id="bb-client-id" type="text" placeholder="Cole o Client ID do portal BB"
                   style="width:100%;padding:7px 10px;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;box-sizing:border-box">
          </div>
          <div>
            <label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">CLIENT SECRET</label>
            <input id="bb-client-secret" type="password" placeholder="Cole o Client Secret"
                   style="width:100%;padding:7px 10px;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;box-sizing:border-box">
          </div>
          <!-- Certificado A1 — só produção -->
          <div id="bb-cert-area" style="display:none;grid-column:1/-1;background:#fef9c3;
                border-radius:8px;padding:10px;gap:6px;flex-direction:column">
            <div style="font-size:11px;font-weight:700;color:#854d0e">🔒 Certificado A1 (opcional em produção)</div>
            <label style="font-size:10px;color:#64748b">Caminho do .pem no servidor (deixe vazio para tentar sem mTLS)</label>
            <input id="bb-cert-path" type="text" placeholder="/opt/montana/certs/assessoria.pem"
                   style="width:100%;padding:7px;border:1px solid #fde68a;border-radius:6px;font-size:11px;box-sizing:border-box">
            <label style="font-size:10px;color:#64748b">Caminho da chave privada .key</label>
            <input id="bb-key-path" type="text" placeholder="/opt/montana/certs/assessoria.key"
                   style="width:100%;padding:7px;border:1px solid #fde68a;border-radius:6px;font-size:11px;box-sizing:border-box">
          </div>
          <button onclick="bbSalvarConfig()"
                  style="background:#1a3a6b;color:#fff;border:none;border-radius:8px;
                         padding:9px;font-size:12px;font-weight:700;cursor:pointer">
            💾 Salvar Credenciais
          </button>
        </div>
      </details>

      <!-- Contas extras -->
      <div id="bb-extra-contas-area" style="display:none">
        <div style="font-size:12px;font-weight:700;color:#1a3a6b;margin-bottom:8px">➕ Contas adicionais</div>
        <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:6px;align-items:end">
          <div>
            <label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">AGÊNCIA</label>
            <input id="bb-extra-agencia" type="text" placeholder="1505"
                   style="width:100%;padding:6px 8px;border:1px solid #e2e8f0;border-radius:7px;font-size:12px;box-sizing:border-box">
          </div>
          <div>
            <label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">CONTA</label>
            <input id="bb-extra-conta" type="text" placeholder="650757"
                   style="width:100%;padding:6px 8px;border:1px solid #e2e8f0;border-radius:7px;font-size:12px;box-sizing:border-box">
          </div>
          <button onclick="bbAdicionarConta()"
                  style="background:#16a34a;color:#fff;border:none;border-radius:7px;
                         padding:6px 12px;font-size:13px;cursor:pointer;white-space:nowrap">
            ＋
          </button>
        </div>
        <div style="font-size:10px;color:#94a3b8;margin-top:4px">
          Ex: Conta Motoristas (650757), Conta Poupança, etc.
        </div>
      </div>

      <!-- Sync -->
      <div id="bb-sync-area" style="display:none">
        <div style="font-size:12px;font-weight:700;color:#1a3a6b;margin-bottom:10px">🔄 Importar Lançamentos</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
          <div>
            <label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">DE</label>
            <input type="date" id="bb-data-ini"
                   style="width:100%;padding:7px;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;box-sizing:border-box">
          </div>
          <div>
            <label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">ATÉ</label>
            <input type="date" id="bb-data-fim"
                   style="width:100%;padding:7px;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;box-sizing:border-box">
          </div>
        </div>
        <div style="display:flex;gap:8px">
          <button id="bb-sync-btn" onclick="bbSyncManual()"
                  style="flex:1;background:#f9a825;color:#1a3a6b;border:none;border-radius:8px;
                         padding:10px;font-size:13px;font-weight:800;cursor:pointer">
            ⚡ Importar Agora
          </button>
          <button onclick="bbRemoverConfig()" title="Remover credenciais"
                  style="background:#fff;color:#ef4444;border:1px solid #fecaca;
                         border-radius:8px;padding:10px 14px;font-size:14px;cursor:pointer">
            🗑️
          </button>
        </div>
        <div id="bb-sync-resultado" style="margin-top:8px;font-size:11px;color:#475569;display:none"></div>
        <div style="margin-top:8px;font-size:11px;color:#94a3b8;text-align:center">
          Sync automático: todo dia às 06h00
        </div>
      </div>

      <!-- Histórico -->
      <div id="bb-historico"></div>

    </div><!-- /body -->
  `;
  document.body.appendChild(div);

  // Datas padrão: últimos 30 dias
  const hoje = new Date();
  const ini  = new Date(hoje); ini.setDate(ini.getDate() - 30);
  const fmt  = d => d.toISOString().split('T')[0];
  document.getElementById('bb-data-fim').value = fmt(hoje);
  document.getElementById('bb-data-ini').value = fmt(ini);

  // Mostra área cert se produção já selecionado
  document.getElementById('bb-cert-area').style.display = 'flex';

  bbCarregarStatus();
}

// ── API helper ────────────────────────────────────────────────────────────────
function _bbApi(path, opts) {
  if (typeof api === 'function') return api('/bb' + path, opts);
  const token   = localStorage.getItem('montana_jwt') || '';
  const company = localStorage.getItem('montana_company') || 'assessoria';
  const headers = { 'X-Company': company, ...(opts?.headers || {}) };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return fetch('/api/bb' + path, { ...opts, headers }).then(r => r.json());
}

// ── Carregar status ───────────────────────────────────────────────────────────
async function bbCarregarStatus() {
  const empresa = window.currentCompany || localStorage.getItem('montana_company') || '';
  const label = document.getElementById('bb-empresa-label');
  if (label) label.textContent = empresa.charAt(0).toUpperCase() + empresa.slice(1);

  try {
    const r    = await _bbApi('/status');
    const bar  = document.getElementById('bb-status-bar');
    const det  = document.getElementById('bb-details-config');
    const sync = document.getElementById('bb-sync-area');
    const extra = document.getElementById('bb-extra-contas-area');
    const contasLista = document.getElementById('bb-contas-lista');

    const ambLabel = r.ambiente === 'sandbox' ? '🧪 Sandbox'
                   : r.ambiente === 'homologacao' ? '🔬 Homologação'
                   : '🔒 Produção';

    if (r.configurado) {
      bar.innerHTML = `
        <span style="color:#16a34a;font-weight:700">✅ Configurado</span>
        &nbsp;·&nbsp;${ambLabel}
        &nbsp;·&nbsp;Ag: ${r.agencia} Conta: ${r.conta}
        ${r.total_contas > 1 ? `&nbsp;·&nbsp;<span style="color:#2563eb;font-weight:700">${r.total_contas} contas</span>` : ''}
        ${r.ultimo_sync ? `&nbsp;·&nbsp;Sync: ${new Date(r.ultimo_sync).toLocaleString('pt-BR')}` : ''}
      `;

      // Lista de contas
      if (r.contas && r.contas.length > 0) {
        contasLista.style.display = 'block';
        contasLista.innerHTML = `
          <div style="font-weight:700;color:#16a34a;margin-bottom:6px">📋 Contas vinculadas:</div>
          ${r.contas.map((c, i) => `
            <div style="display:flex;justify-content:space-between;align-items:center;
                        padding:3px 0;${i < r.contas.length-1 ? 'border-bottom:1px solid #bbf7d0' : ''}">
              <span>Ag ${c.agencia} · Conta ${c.conta}
                <span style="color:#64748b;font-size:10px"> — ${c.descricao}</span>
              </span>
              ${i > 0 ? `<button onclick="bbRemoverContaExtra('${c.conta.replace(/\*/g,'')}')"
                style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:12px;padding:0 4px">✕</button>` : ''}
            </div>
          `).join('')}
        `;
      }

      if (det) det.removeAttribute('open');
      if (sync) sync.style.display = 'block';
      if (extra) extra.style.display = 'block';
      bbCarregarHistorico();
    } else {
      if (bar) bar.innerHTML = `<span style="color:#f59e0b;font-weight:700">⚠️ Não configurado</span> — preencha as credenciais`;
      if (sync) sync.style.display = 'none';
      if (extra) extra.style.display = 'none';
      if (contasLista) contasLista.style.display = 'none';
      if (det) det.setAttribute('open', '');
    }
  } catch(e) {
    const bar = document.getElementById('bb-status-bar');
    if (bar) bar.innerHTML = `<span style="color:#ef4444">Erro ao verificar: ${e.message}</span>`;
  }
}

// ── Salvar config principal ───────────────────────────────────────────────────
async function bbSalvarConfig() {
  const get = id => document.getElementById(id)?.value?.trim() || '';
  const payload = {
    client_id:     get('bb-client-id'),
    client_secret: get('bb-client-secret'),
    app_key:       get('bb-app-key'),
    agencia:       get('bb-agencia'),
    conta:         get('bb-conta'),
    ambiente:      get('bb-ambiente') || 'producao',
    cert_path:     get('bb-cert-path'),
    key_path:      get('bb-key-path'),
  };
  if (!payload.client_id || !payload.client_secret || !payload.app_key || !payload.agencia || !payload.conta) {
    if (typeof showToast === 'function') showToast('Preencha todos os campos obrigatórios', 'error');
    else alert('Preencha todos os campos'); return;
  }
  try {
    const r = await _bbApi('/config', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' }
    });
    if (r.ok) {
      if (typeof showToast === 'function') showToast('✅ Credenciais BB salvas!');
      bbCarregarStatus();
    } else {
      if (typeof showToast === 'function') showToast(r.error || 'Erro ao salvar', 'error');
    }
  } catch(e) {
    if (typeof showToast === 'function') showToast('Erro: ' + e.message, 'error');
  }
}

// ── Adicionar conta extra ─────────────────────────────────────────────────────
async function bbAdicionarConta() {
  const agencia = document.getElementById('bb-extra-agencia')?.value?.trim();
  const conta   = document.getElementById('bb-extra-conta')?.value?.trim();
  if (!agencia || !conta) {
    if (typeof showToast === 'function') showToast('Informe agência e conta', 'error'); return;
  }
  try {
    const r = await _bbApi('/config/conta', {
      method: 'POST',
      body: JSON.stringify({ agencia, conta, descricao: `Conta ${conta}` }),
      headers: { 'Content-Type': 'application/json' }
    });
    if (r.ok) {
      if (typeof showToast === 'function') showToast(`✅ Conta ${conta} adicionada`);
      document.getElementById('bb-extra-agencia').value = '';
      document.getElementById('bb-extra-conta').value = '';
      bbCarregarStatus();
    } else {
      if (typeof showToast === 'function') showToast(r.error || 'Erro', 'error');
    }
  } catch(e) {
    if (typeof showToast === 'function') showToast('Erro: ' + e.message, 'error');
  }
}

// ── Remover conta extra ───────────────────────────────────────────────────────
async function bbRemoverContaExtra(conta) {
  if (!confirm(`Remover a conta ${conta} das contas sincronizadas?\n(Os extratos já importados são mantidos.)`)) return;
  try {
    await _bbApi('/config/conta', {
      method: 'DELETE',
      body: JSON.stringify({ conta }),
      headers: { 'Content-Type': 'application/json' }
    });
    if (typeof showToast === 'function') showToast(`Conta ${conta} removida`);
    bbCarregarStatus();
  } catch(e) {
    if (typeof showToast === 'function') showToast('Erro: ' + e.message, 'error');
  }
}

// ── Sync manual ───────────────────────────────────────────────────────────────
async function bbSyncManual() {
  const dataInicio = document.getElementById('bb-data-ini')?.value;
  const dataFim    = document.getElementById('bb-data-fim')?.value;
  if (!dataInicio || !dataFim) {
    if (typeof showToast === 'function') showToast('Selecione o período', 'error'); return;
  }
  const btn = document.getElementById('bb-sync-btn');
  const res = document.getElementById('bb-sync-resultado');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Importando…'; }
  if (res) res.style.display = 'none';

  try {
    const r = await _bbApi('/sync', {
      method: 'POST',
      body: JSON.stringify({ dataInicio, dataFim }),
      headers: { 'Content-Type': 'application/json' }
    });
    if (r.ok) {
      if (typeof showToast === 'function') showToast(`✅ ${r.message}`);

      // Mostra resultado por conta
      if (res && r.contas?.length) {
        res.style.display = 'block';
        res.innerHTML = r.contas.map(c => `
          <div style="padding:3px 0;border-bottom:1px solid #f1f5f9">
            ${c.erro
              ? `❌ Conta ${c.conta}: <span style="color:#ef4444">${c.erro.substring(0,80)}</span>`
              : `✅ Conta ${c.conta} (${c.descricao}): <b>+${c.imported}</b> importados${c.skipped ? ` · ${c.skipped} existentes` : ''}`
            }
          </div>
        `).join('');
      }

      bbCarregarStatus();
      if (typeof loadDashboard === 'function') loadDashboard();
      if (typeof loadExtratos  === 'function') loadExtratos();
    } else {
      if (typeof showToast === 'function') showToast(r.error || 'Erro no sync BB', 'error');
      else alert('Erro: ' + (r.error || 'desconhecido'));
    }
  } catch(e) {
    if (typeof showToast === 'function') showToast('Erro: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Importar Agora'; }
  }
}

// ── Remover config ────────────────────────────────────────────────────────────
async function bbRemoverConfig() {
  if (!confirm('Remover TODAS as credenciais BB desta empresa?\nOs extratos já importados serão mantidos.')) return;
  try {
    await _bbApi('/config', { method: 'DELETE' });
    if (typeof showToast === 'function') showToast('Credenciais BB removidas');
    bbCarregarStatus();
    document.getElementById('bb-details-config')?.setAttribute('open', '');
    document.getElementById('bb-sync-area').style.display = 'none';
    document.getElementById('bb-extra-contas-area').style.display = 'none';
    document.getElementById('bb-contas-lista').style.display = 'none';
    document.getElementById('bb-historico').innerHTML = '';
  } catch(e) {
    if (typeof showToast === 'function') showToast('Erro: ' + e.message, 'error');
  }
}

// ── Histórico de syncs ────────────────────────────────────────────────────────
async function bbCarregarHistorico() {
  try {
    const r   = await _bbApi('/historico');
    const div = document.getElementById('bb-historico');
    if (!div || !r.historico?.length) return;
    div.innerHTML = `
      <div style="font-size:11px;font-weight:700;color:#64748b;margin-bottom:6px">📋 Histórico de Syncs</div>
      ${r.historico.map(h => `
        <div style="display:flex;justify-content:space-between;align-items:center;
                    padding:5px 0;border-bottom:1px solid #f1f5f9;font-size:11px">
          <span style="color:#475569">${h.arquivo}</span>
          <span style="background:#dcfce7;color:#16a34a;font-weight:700;
                       padding:2px 8px;border-radius:10px">+${h.registros}</span>
        </div>
      `).join('')}
    `;
  } catch(_) {}
}
