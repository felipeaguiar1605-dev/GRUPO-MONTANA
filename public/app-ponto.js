// ─── Montana — Módulo Controle de Ponto e Frequência v2 ──────────────────────
// Melhorias: feriados, _calcDia, edição, importação Excel, PDF, jornadas UI

// ─── Extensão do showTab ──────────────────────────────────────────────────────
(function () {
  const _orig = window.showTab;
  window.showTab = function (id, el) {
    _orig(id, el);
    if (id === 'ponto') loadPonto();
  };
})();

// ─── Estado ───────────────────────────────────────────────────────────────────
let _pontoFuncionarios = [];
let _pontoSubTabAtual  = 'registro';

// ─── Feriados fixos no frontend (para highlight visual) ──────────────────────
const FERIADOS_FIXOS_FE = new Set(['01-01','04-21','05-01','09-07','10-12','11-02','11-15','11-20','12-25']);

// ─── Init ─────────────────────────────────────────────────────────────────────
async function loadPonto() {
  await _pontoCarregarFuncionarios();
  _pontoPreencherFiltros();
  _pontoSetarDefaults();
  pontoSubTab(_pontoSubTabAtual);
}

async function _pontoCarregarFuncionarios() {
  const data = await api('/rh/funcionarios?status=ATIVO');
  // O endpoint /rh/funcionarios retorna array diretamente
  _pontoFuncionarios = Array.isArray(data) ? data : (data && data.data ? data.data : []);
}

function _pontoPreencherFiltros() {
  const funcs   = _pontoFuncionarios;
  const optsTodos = `<option value="">Todos</option>` +
    funcs.map(f => `<option value="${f.id}">${f.nome}${f.lotacao ? ' — ' + f.lotacao : ''}</option>`).join('');
  const optsReq = funcs.map(f =>
    `<option value="${f.id}">${f.nome}${f.lotacao ? ' — ' + f.lotacao : ''}</option>`
  ).join('');

  [['ponto-func-filtro', false], ['espelho-func-sel', true], ['oc-func-filtro', false],
   ['reg-func-id', true], ['oc-func-id', true], ['jorn-func-sel', false]].forEach(([id, req]) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = req ? optsReq : optsTodos;
  });
}

function _pontoSetarDefaults() {
  const hoje     = new Date().toISOString().substring(0, 10);
  const mesAtual = hoje.substring(0, 7);
  const agora    = new Date(); agora.setSeconds(0, 0);
  const agoraStr = agora.toISOString().substring(0, 16);

  _setValorSeVazio('ponto-data-filtro', hoje);
  _setValorSeVazio('espelho-mes',  mesAtual);
  _setValorSeVazio('freq-mes',     mesAtual);
  _setValorSeVazio('oc-from',      mesAtual + '-01');
  _setValorSeVazio('oc-to',        hoje);
  _setValorSeVazio('reg-data-hora', agoraStr);
  _setValorSeVazio('edit-reg-data-hora', agoraStr);
}

function _setValorSeVazio(id, val) {
  const el = document.getElementById(id);
  if (el && !el.value) el.value = val;
}

// ─── Sub-abas ─────────────────────────────────────────────────────────────────
function pontoSubTab(tab) {
  _pontoSubTabAtual = tab;
  const paineis = ['registro', 'espelho', 'frequencia', 'ocorrencias', 'jornadas'];
  paineis.forEach(p => {
    const panel = document.getElementById(`ponto-panel-${p}`);
    const btn   = document.getElementById(`ponto-tab-${p}`);
    if (!panel || !btn) return;
    const ativo = (p === tab);
    panel.style.display         = ativo ? '' : 'none';
    btn.style.borderBottomColor = ativo ? '#0f766e' : 'transparent';
    btn.style.color             = ativo ? '#0f766e' : '#64748b';
    btn.style.fontWeight        = ativo ? '700' : '600';
  });
  if (tab === 'registro')   loadPontoRegistros();
  if (tab === 'ocorrencias') loadOcorrencias();
  if (tab === 'jornadas')   loadJornadas();
}

// ─── KPIs ─────────────────────────────────────────────────────────────────────
function _renderPontoKpis(registros) {
  const hoje     = new Date().toISOString().substring(0, 10);
  const hojeRegs = registros.filter(r => r.data_hora && r.data_hora.substring(0,10) === hoje);
  const entradas = hojeRegs.filter(r => r.tipo === 'entrada').length;
  const saidas   = hojeRegs.filter(r => r.tipo === 'saida').length;
  document.getElementById('ponto-kpis').innerHTML = `
    <div class="kpi-card" style="border-left:4px solid #0f766e">
      <div class="kpi-v" style="color:#0f766e">${entradas}</div>
      <div class="kpi-l">Entradas Hoje</div>
    </div>
    <div class="kpi-card" style="border-left:4px solid #dc2626">
      <div class="kpi-v" style="color:#dc2626">${saidas}</div>
      <div class="kpi-l">Saídas Hoje</div>
    </div>
    <div class="kpi-card" style="border-left:4px solid #0891b2">
      <div class="kpi-v" style="color:#0891b2">${Math.max(0, entradas - saidas)}</div>
      <div class="kpi-l">Presentes Agora</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-v">${_pontoFuncionarios.length}</div>
      <div class="kpi-l">Funcionários Ativos</div>
    </div>`;
}

// ─── Sub-aba: Registro do Dia ─────────────────────────────────────────────────
async function loadPontoRegistros() {
  const data   = document.getElementById('ponto-data-filtro')?.value || new Date().toISOString().substring(0, 10);
  const funcId = document.getElementById('ponto-func-filtro')?.value || '';
  let url = `/ponto?data=${data}`;
  if (funcId) url += `&funcionario_id=${funcId}`;

  const res  = await api(url);
  const rows = (res && res.data) ? res.data : [];
  _renderPontoKpis(rows);

  const porFunc = {};
  for (const r of rows) {
    if (!porFunc[r.funcionario_id]) porFunc[r.funcionario_id] = { nome: r.funcionario_nome, cargo: r.cargo_nome, registros: [] };
    porFunc[r.funcionario_id].registros.push(r);
  }
  // Inclui funcionários sem registro
  _pontoFuncionarios.forEach(f => {
    if (!porFunc[f.id]) porFunc[f.id] = { nome: f.nome, cargo: f.cargo_nome || '', registros: [] };
  });

  document.getElementById('ponto-reg-head').innerHTML = `<tr>
    <th>Funcionário</th><th>Cargo / Posto</th>
    <th style="text-align:center">Entrada</th>
    <th style="text-align:center">Int.Início</th>
    <th style="text-align:center">Int.Fim</th>
    <th style="text-align:center">Saída</th>
    <th style="text-align:center">Status</th>
    <th style="text-align:center">Ações</th>
  </tr>`;

  const hora   = r => r ? r.data_hora.substring(11, 16) : '<span style="color:#cbd5e1">—</span>';
  const acoes  = r => r ? `
    <button onclick="abrirEditarRegistro(${r.id},'${r.tipo}','${r.data_hora}','${(r.observacao||'').replace(/'/g,"\\'")}'')" title="Editar" style="background:#dbeafe;color:#1d4ed8;border:none;padding:2px 5px;border-radius:4px;font-size:9px;cursor:pointer;margin:1px">✏️</button>
    <button onclick="deletarRegistroPonto(${r.id})" title="Excluir" style="background:#fee2e2;color:#dc2626;border:none;padding:2px 5px;border-radius:4px;font-size:9px;cursor:pointer;margin:1px">✕</button>` : '';

  document.getElementById('ponto-reg-body').innerHTML = Object.entries(porFunc).map(([fid, fd]) => {
    const reg      = fd.registros;
    const entrada  = reg.find(r => r.tipo === 'entrada');
    const saida    = reg.find(r => r.tipo === 'saida');
    const intInic  = reg.find(r => r.tipo === 'intervalo_inicio');
    const intFim   = reg.find(r => r.tipo === 'intervalo_fim');

    let status = '<span style="color:#94a3b8;font-size:10px">Sem registro</span>';
    if (saida)                status = '<span style="background:#dcfce7;color:#15803d;padding:2px 8px;border-radius:20px;font-size:9px;font-weight:700">✔ Completo</span>';
    else if (intInic && !intFim) status = '<span style="background:#fef3c7;color:#d97706;padding:2px 8px;border-radius:20px;font-size:9px;font-weight:700">☕ Intervalo</span>';
    else if (entrada)         status = '<span style="background:#dbeafe;color:#1d4ed8;padding:2px 8px;border-radius:20px;font-size:9px;font-weight:700">▶ Trabalhando</span>';

    return `<tr>
      <td><strong>${fd.nome}</strong></td>
      <td style="font-size:10px;color:#64748b">${fd.cargo || '—'}</td>
      <td style="text-align:center">${hora(entrada)}${acoes(entrada)}</td>
      <td style="text-align:center">${hora(intInic)}${acoes(intInic)}</td>
      <td style="text-align:center">${hora(intFim)}${acoes(intFim)}</td>
      <td style="text-align:center">${hora(saida)}${acoes(saida)}</td>
      <td style="text-align:center">${status}</td>
      <td style="text-align:center">
        <button onclick="pontoRegistrarRapido(${fid},'entrada')" style="background:#ccfbf1;color:#0f766e;border:none;padding:3px 7px;border-radius:4px;font-size:9px;cursor:pointer;margin:1px">▶ Entrada</button>
        <button onclick="pontoRegistrarRapido(${fid},'saida')"  style="background:#fee2e2;color:#dc2626;border:none;padding:3px 7px;border-radius:4px;font-size:9px;cursor:pointer;margin:1px">■ Saída</button>
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:20px">Nenhum registro.</td></tr>`;
}

async function pontoRegistrarRapido(funcId, tipo) {
  const agora = new Date(); agora.setSeconds(0,0);
  const dh = agora.toISOString().substring(0, 16);
  const res = await api('/ponto/registrar', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ funcionario_id: funcId, tipo, data_hora: dh }) });
  if (res && res.ok) { toast(`✔ ${tipo === 'entrada' ? 'Entrada' : 'Saída'} registrada`); loadPontoRegistros(); }
  else toast((res && res.error) || 'Erro ao registrar', 'erro');
}

async function deletarRegistroPonto(id) {
  if (!confirm('Excluir este registro de ponto?')) return;
  const res = await api(`/ponto/${id}`, { method: 'DELETE' });
  if (res && res.ok) { toast('Registro excluído'); loadPontoRegistros(); }
  else toast((res && res.error) || 'Erro', 'erro');
}

// ─── Modal: Registrar Ponto ───────────────────────────────────────────────────
function pontoRegistrarModal(funcId) {
  const agora = new Date(); agora.setSeconds(0,0);
  const el = document.getElementById('reg-data-hora');
  if (el) el.value = agora.toISOString().substring(0, 16);
  if (funcId) { const s = document.getElementById('reg-func-id'); if (s) s.value = funcId; }
  document.getElementById('modal-ponto-registrar').style.display = 'flex';
}

async function salvarRegistroPonto() {
  const funcId   = document.getElementById('reg-func-id')?.value;
  const tipo     = document.getElementById('reg-tipo')?.value;
  const dataHora = document.getElementById('reg-data-hora')?.value;
  const obs      = document.getElementById('reg-obs')?.value || '';
  if (!funcId || !tipo || !dataHora) return toast('Preencha todos os campos obrigatórios', 'erro');
  const res = await api('/ponto/registrar', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ funcionario_id: Number(funcId), tipo, data_hora: dataHora, observacao: obs }) });
  if (res && res.ok) {
    toast('✔ Ponto registrado');
    document.getElementById('modal-ponto-registrar').style.display = 'none';
    document.getElementById('reg-obs').value = '';
    loadPontoRegistros();
  } else toast((res && res.error) || 'Erro', 'erro');
}

// ─── Modal: Editar Registro ───────────────────────────────────────────────────
let _editandoRegId = null;

function abrirEditarRegistro(id, tipo, dataHora, obs) {
  _editandoRegId = id;
  const t = document.getElementById('edit-reg-tipo');
  const d = document.getElementById('edit-reg-data-hora');
  const o = document.getElementById('edit-reg-obs');
  if (t) t.value = tipo;
  if (d) d.value = dataHora.substring(0, 16);
  if (o) o.value = obs || '';
  document.getElementById('modal-editar-registro').style.display = 'flex';
}

async function salvarEdicaoRegistro() {
  if (!_editandoRegId) return;
  const tipo     = document.getElementById('edit-reg-tipo')?.value;
  const dataHora = document.getElementById('edit-reg-data-hora')?.value;
  const obs      = document.getElementById('edit-reg-obs')?.value || '';
  const res = await api(`/ponto/${_editandoRegId}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tipo, data_hora: dataHora, observacao: obs }) });
  if (res && res.ok) {
    toast('✔ Registro atualizado');
    document.getElementById('modal-editar-registro').style.display = 'none';
    loadPontoRegistros();
  } else toast((res && res.error) || 'Erro', 'erro');
}

// ─── Sub-aba: Espelho Mensal ──────────────────────────────────────────────────
async function loadEspelho() {
  const funcId = document.getElementById('espelho-func-sel')?.value;
  const mes    = document.getElementById('espelho-mes')?.value;
  if (!funcId) return toast('Selecione um funcionário', 'erro');
  if (!mes)    return toast('Selecione o mês', 'erro');

  const res = await apiLoading(`/ponto/espelho?funcionario_id=${funcId}&mes=${mes}`, {}, 'Gerando espelho…');
  if (!res || !res.ok) return toast((res && res.error) || 'Erro', 'erro');

  const { funcionario: func, resumo, dias, jornada } = res;

  document.getElementById('espelho-resumo').style.display = '';
  document.getElementById('espelho-resumo-titulo').textContent =
    `${func ? func.nome : ''} — ${mes} — Jornada: ${jornada.entrada||'08:00'}–${jornada.saida||'17:00'} (${jornada.horas_dia||8}h/dia)`;

  const bCorBanco = resumo.banco_horas && resumo.banco_horas.startsWith('-') ? '#dc2626' : '#0891b2';
  document.getElementById('espelho-kpis').innerHTML = `
    <div class="kpi-card" style="border-left:4px solid #0f766e"><div class="kpi-v" style="color:#0f766e">${resumo.dias_trabalhados}</div><div class="kpi-l">Dias Trabalhados</div></div>
    <div class="kpi-card" style="border-left:4px solid #dc2626"><div class="kpi-v" style="color:#dc2626">${resumo.dias_falta}</div><div class="kpi-l">Faltas</div></div>
    <div class="kpi-card" style="border-left:4px solid #d97706"><div class="kpi-v" style="color:#d97706">${resumo.atrasos||0}</div><div class="kpi-l">Atrasos</div></div>
    <div class="kpi-card" style="border-left:4px solid #15803d"><div class="kpi-v" style="color:#15803d">${resumo.total_horas_extras}</div><div class="kpi-l">Horas Extras</div></div>
    <div class="kpi-card" style="border-left:4px solid #7c3aed"><div class="kpi-v" style="color:#7c3aed">${resumo.total_horas_faltantes}</div><div class="kpi-l">H. Faltantes</div></div>
    <div class="kpi-card" style="border-left:4px solid ${bCorBanco}"><div class="kpi-v" style="color:${bCorBanco}">${resumo.banco_horas}</div><div class="kpi-l">Banco de Horas</div></div>`;

  document.getElementById('espelho-head').innerHTML = `<tr>
    <th>Data</th><th>Dia</th>
    <th style="text-align:center">Entrada</th>
    <th style="text-align:center">Int.In</th>
    <th style="text-align:center">Int.Fim</th>
    <th style="text-align:center">Saída</th>
    <th style="text-align:right">Trabalhado</th>
    <th style="text-align:right">Extras</th>
    <th style="text-align:right">Faltas</th>
    <th>Ocorrência / Feriado</th>
  </tr>`;

  const hora = v => v || '<span style="color:#cbd5e1">—</span>';
  const hCor = (h, cPos) => !h || h==='00:00' ? '<span style="color:#94a3b8">—</span>' : `<span style="color:${cPos};font-weight:600">${h}</span>`;

  document.getElementById('espelho-body').innerHTML = dias.map(d => {
    const bgRow = (d.fim_semana || d.feriado) ? 'background:#f8fafc' : (d.ocorrencia ? 'background:#fef3c7' : '');
    const corDia = (d.fim_semana || d.feriado) ? '#94a3b8' : '#334155';
    const ferBadge = d.feriado ? `<span style="background:#fee2e2;color:#dc2626;padding:1px 6px;border-radius:20px;font-size:8px;font-weight:700">Feriado</span>` : '';
    const ocBadge  = d.ocorrencia ? `<span style="background:#fef3c7;color:#d97706;padding:1px 6px;border-radius:20px;font-size:8px;font-weight:700">${_ocTipoLabel(d.ocorrencia.tipo)}</span>` : '';
    const atrasoBadge = d.tem_atraso ? `<span style="background:#fef9c3;color:#ca8a04;padding:1px 5px;border-radius:20px;font-size:8px">atraso</span>` : '';
    return `<tr style="${bgRow}">
      <td><strong style="color:${corDia}">${_formatarData(d.data)}</strong></td>
      <td style="color:${corDia}">${d.dia_semana}</td>
      <td style="text-align:center;font-family:monospace">${hora(d.entrada)} ${atrasoBadge}</td>
      <td style="text-align:center;font-family:monospace;color:#94a3b8">${hora(d.intervalo_inicio)}</td>
      <td style="text-align:center;font-family:monospace;color:#94a3b8">${hora(d.intervalo_fim)}</td>
      <td style="text-align:center;font-family:monospace">${hora(d.saida)}</td>
      <td style="text-align:right">${d.fim_semana||d.feriado?'—': hCor(d.horas_trabalhadas,'#334155')}</td>
      <td style="text-align:right">${d.fim_semana||d.feriado?'': hCor(d.horas_extras,'#15803d')}</td>
      <td style="text-align:right">${d.fim_semana||d.feriado?'': hCor(d.horas_faltantes,'#dc2626')}</td>
      <td>${ferBadge}${ocBadge}</td>
    </tr>`;
  }).join('');
}

// Botão PDF do espelho
async function baixarEspelhoPDF() {
  const funcId = document.getElementById('espelho-func-sel')?.value;
  const mes    = document.getElementById('espelho-mes')?.value;
  if (!funcId || !mes) return toast('Selecione funcionário e mês primeiro', 'erro');
  const company = window.currentCompany || 'assessoria';
  const token   = localStorage.getItem('montana_token') || '';
  const url     = `/api/ponto/espelho-pdf?funcionario_id=${funcId}&mes=${mes}`;
  const resp    = await fetch(url, { headers: { 'X-Company': company, 'Authorization': `Bearer ${token}` } });
  if (!resp.ok) { const e = await resp.json(); return toast(e.error || 'Erro ao gerar PDF', 'erro'); }
  const blob = await resp.blob();
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `espelho_ponto_${mes}.pdf`;
  a.click();
  toast('✔ PDF gerado');
}

function verPontoFuncionario(funcId) {
  const tabEl = document.querySelector('[data-tab="ponto"]');
  if (tabEl) showTab('ponto', tabEl);
  setTimeout(() => {
    const sel = document.getElementById('espelho-func-sel');
    if (sel) { sel.value = funcId; pontoSubTab('espelho'); loadEspelho(); }
  }, 400);
}

// ─── Sub-aba: Frequência ──────────────────────────────────────────────────────
async function loadFrequencia() {
  const mes = document.getElementById('freq-mes')?.value;
  if (!mes) return toast('Selecione o mês', 'erro');
  const res = await apiLoading(`/ponto/relatorio-frequencia?mes=${mes}`, {}, 'Gerando relatório…');
  if (!res || !res.ok) return toast((res && res.error) || 'Erro', 'erro');
  const rows = res.data || [];

  document.getElementById('freq-head').innerHTML = `<tr>
    <th>Funcionário</th><th>Cargo</th><th>Lotação</th>
    <th style="text-align:center">Dias Úteis</th>
    <th style="text-align:center">Trabalhados</th>
    <th style="text-align:center">Faltas</th>
    <th style="text-align:center">Atrasos</th>
    <th style="text-align:right">H. Extras</th>
    <th style="text-align:right">H. Faltantes</th>
    <th style="text-align:right">Banco Horas</th>
    <th style="text-align:center">Ocorrências</th>
    <th style="text-align:center">Espelho</th>
  </tr>`;

  const bCorH = h => {
    if (!h || h==='00:00') return '<span style="color:#94a3b8">—</span>';
    return `<span style="color:${h.startsWith('-')?'#dc2626':'#15803d'};font-weight:600">${h}</span>`;
  };

  document.getElementById('freq-body').innerHTML = rows.length === 0
    ? `<tr><td colspan="12" style="text-align:center;color:#94a3b8;padding:20px">Nenhum funcionário ativo.</td></tr>`
    : rows.map(r => `<tr>
        <td><strong>${r.nome}</strong></td>
        <td style="font-size:10px;color:#64748b">${r.cargo||'—'}</td>
        <td style="font-size:10px;color:#64748b">${r.lotacao||'—'}</td>
        <td style="text-align:center">${r.dias_uteis}</td>
        <td style="text-align:center;font-weight:700;color:${r.dias_trabalhados===r.dias_uteis?'#15803d':'#334155'}">${r.dias_trabalhados}</td>
        <td style="text-align:center;color:${r.dias_falta>0?'#dc2626':'#94a3b8'};font-weight:${r.dias_falta>0?'700':'400'}">${r.dias_falta||'—'}</td>
        <td style="text-align:center;color:${r.atrasos>0?'#d97706':'#94a3b8'}">${r.atrasos||'—'}</td>
        <td style="text-align:right">${bCorH(r.horas_extras)}</td>
        <td style="text-align:right">${bCorH(r.horas_faltantes)}</td>
        <td style="text-align:right">${bCorH(r.banco_horas)}</td>
        <td style="text-align:center;color:${r.ocorrencias>0?'#d97706':'#94a3b8'}">${r.ocorrencias||'—'}</td>
        <td style="text-align:center">
          <button onclick="verPontoFuncionario(${r.funcionario_id})" style="background:#ccfbf1;color:#0f766e;border:none;padding:3px 8px;border-radius:4px;font-size:9px;cursor:pointer">🗓️ Espelho</button>
        </td>
      </tr>`).join('');
}

async function exportarPontoExcel() {
  const mes = document.getElementById('freq-mes')?.value || new Date().toISOString().substring(0,7);
  const company = window.currentCompany || 'assessoria';
  const token   = localStorage.getItem('montana_token') || '';
  const resp    = await fetch(`/api/ponto/export?mes=${mes}`, { headers: { 'X-Company': company, 'Authorization': `Bearer ${token}` } });
  const blob    = await resp.blob();
  const a       = document.createElement('a');
  a.href        = URL.createObjectURL(blob);
  a.download    = `frequencia_${mes}.xlsx`;
  a.click();
  toast('✔ Excel gerado');
}

async function exportarFolhaFormato(formato) {
  const mes = document.getElementById('freq-mes')?.value || new Date().toISOString().substring(0,7);
  const company = window.currentCompany || 'assessoria';
  const token   = localStorage.getItem('montana_token') || '';
  showLoading(`Gerando exportação ${formato.toUpperCase()}…`);
  try {
    const resp = await fetch(`/api/ponto/export-folha?mes=${mes}&formato=${formato}`, {
      headers: { 'X-Company': company, 'Authorization': `Bearer ${token}` }
    });
    const blob = await resp.blob();
    const ext  = formato === 'excel' ? 'xlsx' : 'txt';
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `${formato}_ponto_${mes}.${ext}`;
    a.click();
    toast(`✔ Arquivo ${formato.toUpperCase()} gerado`);
  } catch(e) { toast('Erro ao gerar arquivo', 'erro'); }
  finally { hideLoading(); }
}

async function integrarComFolha() {
  const mes = document.getElementById('freq-mes')?.value || new Date().toISOString().substring(0,7);
  const [ano, m] = mes.split('-');
  const nomeMes = { '01':'Janeiro','02':'Fevereiro','03':'Março','04':'Abril','05':'Maio','06':'Junho',
                    '07':'Julho','08':'Agosto','09':'Setembro','10':'Outubro','11':'Novembro','12':'Dezembro' }[m] || m;
  if (!confirm(`Integrar dados de ponto de ${nomeMes}/${ano} com a folha de pagamento?\n\nIsso criará/atualizará os itens da folha com base nos registros de ponto.`)) return;
  showLoading('Integrando ponto com folha…');
  const res = await api('/ponto/integrar-folha', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ mes }) });
  hideLoading();
  if (res && res.ok) {
    toast(`✔ Folha ${nomeMes}/${ano} integrada — ${res.funcionarios} funcionários · Bruto ${_brl(res.total_bruto)} · Líquido ${_brl(res.total_liquido)}`);
  } else {
    toast((res && res.error) || 'Erro na integração', 'erro');
  }
}

function _brl(v) {
  return (v||0).toLocaleString('pt-BR', {style:'currency', currency:'BRL'});
}

// ─── Sub-aba: Ocorrências ─────────────────────────────────────────────────────
async function loadOcorrencias() {
  const funcId = document.getElementById('oc-func-filtro')?.value || '';
  const from   = document.getElementById('oc-from')?.value || '';
  const to     = document.getElementById('oc-to')?.value || '';
  let url = '/ponto/ocorrencias?_=1';
  if (funcId) url += `&funcionario_id=${funcId}`;
  if (from)   url += `&from=${from}`;
  if (to)     url += `&to=${to}`;

  const res  = await api(url);
  const rows = (res && res.data) ? res.data : [];

  const OC_CORES = {
    falta_justificada:{bg:'#fef3c7',color:'#d97706'},falta_injustificada:{bg:'#fee2e2',color:'#dc2626'},
    atraso:{bg:'#fef9c3',color:'#ca8a04'},licenca_medica:{bg:'#dbeafe',color:'#1d4ed8'},
    ferias:{bg:'#dcfce7',color:'#15803d'},afastamento_inss:{bg:'#ede9fe',color:'#7c3aed'},
    licenca_maternidade:{bg:'#fce7f3',color:'#be185d'},folga_compensatoria:{bg:'#ccfbf1',color:'#0f766e'},
    declaracao:{bg:'#f1f5f9',color:'#475569'},
  };

  document.getElementById('oc-head').innerHTML = `<tr>
    <th>Funcionário</th><th>Tipo</th><th>Data Início</th><th>Data Fim</th>
    <th>Observação</th><th style="text-align:center">Aprovado</th><th style="text-align:center">Ações</th>
  </tr>`;

  document.getElementById('oc-body').innerHTML = rows.length === 0
    ? `<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:20px">Nenhuma ocorrência. Clique em "+ Ocorrência" para registrar.</td></tr>`
    : rows.map(r => {
        const cor = OC_CORES[r.tipo] || {bg:'#f1f5f9',color:'#475569'};
        return `<tr>
          <td><strong>${r.funcionario_nome||'—'}</strong></td>
          <td><span style="background:${cor.bg};color:${cor.color};padding:2px 8px;border-radius:20px;font-size:9px;font-weight:700">${_ocTipoLabel(r.tipo)}</span></td>
          <td>${_formatarData(r.date_inicio)}</td>
          <td>${r.date_fim?_formatarData(r.date_fim):'—'}</td>
          <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px">${r.observacao||''}</td>
          <td style="text-align:center">
            <button onclick="toggleAprovarOcorrencia(${r.id}, this)"
              style="background:${r.aprovado?'#dcfce7':'#f1f5f9'};color:${r.aprovado?'#15803d':'#64748b'};border:1px solid ${r.aprovado?'#86efac':'#cbd5e1'};padding:3px 10px;border-radius:12px;font-size:9px;cursor:pointer;font-weight:700">
              ${r.aprovado?'✔ Aprovado':'⏳ Pendente'}
            </button>
          </td>
          <td style="text-align:center">
            <button onclick="deletarOcorrencia(${r.id})" style="background:#fee2e2;color:#dc2626;border:none;padding:3px 8px;border-radius:4px;font-size:9px;cursor:pointer">✕</button>
          </td>
        </tr>`;
      }).join('');
}

function pontoOcorrenciaModal(funcId) {
  if (funcId) { const s = document.getElementById('oc-func-id'); if (s) s.value = funcId; }
  document.getElementById('modal-ponto-ocorrencia').style.display = 'flex';
}

async function salvarOcorrencia() {
  const funcId = document.getElementById('oc-func-id')?.value;
  const tipo   = document.getElementById('oc-tipo')?.value;
  const inicio = document.getElementById('oc-inicio')?.value;
  const fim    = document.getElementById('oc-fim')?.value || '';
  const obs    = document.getElementById('oc-obs')?.value || '';
  if (!funcId || !tipo || !inicio) return toast('Preencha funcionário, tipo e data início', 'erro');
  const res = await api('/ponto/ocorrencias', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ funcionario_id: Number(funcId), tipo, date_inicio: inicio, date_fim: fim, observacao: obs }) });
  if (res && res.ok) {
    toast('✔ Ocorrência registrada');
    document.getElementById('modal-ponto-ocorrencia').style.display = 'none';
    document.getElementById('oc-obs').value = '';
    loadOcorrencias();
  } else toast((res && res.error) || 'Erro', 'erro');
}

async function toggleAprovarOcorrencia(id, btn) {
  btn.disabled = true;
  const res = await api(`/ponto/ocorrencias/${id}/aprovar`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' } });
  if (res && res.ok) {
    toast(res.aprovado ? '✔ Ocorrência aprovada' : 'Ocorrência marcada como pendente');
    loadOcorrencias();
  } else {
    toast((res && res.error) || 'Erro', 'erro');
    btn.disabled = false;
  }
}

async function deletarOcorrencia(id) {
  if (!confirm('Excluir esta ocorrência?')) return;
  const res = await api(`/ponto/ocorrencias/${id}`, { method: 'DELETE' });
  if (res && res.ok) { toast('Ocorrência excluída'); loadOcorrencias(); }
  else toast((res && res.error) || 'Erro', 'erro');
}

// ─── Sub-aba: Jornadas ────────────────────────────────────────────────────────
async function loadJornadas() {
  const res  = await api('/ponto/jornadas');
  const rows = (res && res.data) ? res.data : [];
  const pad  = res && res.padrao ? res.padrao : {};

  document.getElementById('jorn-padrao-info').innerHTML = `
    <span style="font-size:10px;color:#64748b">
      Jornada padrão: <strong>${pad.entrada||'08:00'} – ${pad.saida||'17:00'}</strong> ·
      Intervalo: <strong>${pad.intervalo_minutos||60} min</strong> ·
      <strong>${pad.horas_dia||8}h/dia</strong> · <strong>${pad.horas_semana||44}h/semana</strong> ·
      Tolerância: <strong>${pad.tolerancia_minutos||10} min</strong>
    </span>`;

  document.getElementById('jorn-head').innerHTML = `<tr>
    <th>Funcionário</th><th>Cargo</th><th>Entrada</th><th>Saída</th>
    <th>Intervalo (min)</th><th>H/Dia</th><th>H/Semana</th><th>Dias</th>
    <th style="text-align:center">Ações</th>
  </tr>`;

  document.getElementById('jorn-body').innerHTML = rows.length === 0
    ? `<tr><td colspan="9" style="text-align:center;color:#94a3b8;padding:20px">Nenhuma jornada personalizada. Todos usam o padrão CLT (44h/sem).</td></tr>`
    : rows.map(r => `<tr>
        <td>${r.funcionario_nome||'<span style="color:#94a3b8">— (por cargo)</span>'}</td>
        <td style="font-size:10px;color:#64748b">${r.cargo_nome||'—'}</td>
        <td style="font-family:monospace;font-weight:700">${r.entrada}</td>
        <td style="font-family:monospace;font-weight:700">${r.saida}</td>
        <td style="text-align:center">${r.intervalo_minutos}</td>
        <td style="text-align:center">${r.horas_dia}</td>
        <td style="text-align:center">${r.horas_semana}</td>
        <td style="font-size:10px">${(r.dias_semana||'').replace(/,/g,' ')}</td>
        <td style="text-align:center">
          <button onclick="deletarJornada(${r.id})" style="background:#fee2e2;color:#dc2626;border:none;padding:3px 8px;border-radius:4px;font-size:9px;cursor:pointer">✕ Remover</button>
        </td>
      </tr>`).join('');
}

async function toggleJornaTipo() {
  const tipo = document.getElementById('jorn-tipo')?.value;
  const fw = document.getElementById('jorn-func-wrap');
  const cw = document.getElementById('jorn-cargo-wrap');
  if (tipo === 'cargo') {
    fw.style.display = 'none';
    cw.style.display = '';
    const sel = document.getElementById('jorn-cargo-sel');
    if (sel && sel.options.length <= 1) {
      const res = await api('/rh/cargos');
      const cargos = Array.isArray(res) ? res : (res && res.data ? res.data : []);
      sel.innerHTML = cargos.map(c => `<option value="${c.id}">${c.nome}</option>`).join('');
    }
  } else {
    fw.style.display = '';
    cw.style.display = 'none';
  }
}

async function salvarJornada() {
  const tipo     = document.getElementById('jorn-tipo')?.value || 'funcionario';
  const funcId   = tipo === 'funcionario' ? (document.getElementById('jorn-func-sel')?.value || null) : null;
  const cargoId  = tipo === 'cargo' ? (document.getElementById('jorn-cargo-sel')?.value || null) : null;
  const entrada  = document.getElementById('jorn-entrada')?.value || '08:00';
  const saida    = document.getElementById('jorn-saida')?.value || '17:00';
  const interv   = parseInt(document.getElementById('jorn-intervalo')?.value) || 60;
  const hDia     = parseFloat(document.getElementById('jorn-horas-dia')?.value) || 8;
  const hSem     = parseFloat(document.getElementById('jorn-horas-sem')?.value) || 44;
  const dias     = [...document.querySelectorAll('.jorn-dia-check:checked')].map(c => c.value).join(',') || 'seg,ter,qua,qui,sex';

  if (tipo === 'funcionario' && !funcId) return toast('Selecione o funcionário', 'erro');
  if (tipo === 'cargo' && !cargoId) return toast('Selecione o cargo', 'erro');
  const body = { entrada, saida, intervalo_minutos: interv, horas_dia: hDia, horas_semana: hSem, dias_semana: dias };
  if (funcId) body.funcionario_id = Number(funcId);
  if (cargoId) body.cargo_id = Number(cargoId);
  const res = await api('/ponto/jornadas', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if (res && res.ok) { toast('✔ Jornada salva'); loadJornadas(); }
  else toast((res && res.error) || 'Erro', 'erro');
}

async function deletarJornada(id) {
  if (!confirm('Remover jornada personalizada? O funcionário voltará a usar o padrão.')) return;
  const res = await api(`/ponto/jornadas/${id}`, { method: 'DELETE' });
  if (res && res.ok) { toast('Jornada removida'); loadJornadas(); }
  else toast((res && res.error) || 'Erro', 'erro');
}

// ─── Importação Excel em lote ─────────────────────────────────────────────────
async function importarPontoExcel() {
  const fileEl = document.getElementById('ponto-import-file');
  if (!fileEl || !fileEl.files[0]) return toast('Selecione um arquivo .xlsx', 'erro');

  const fd = new FormData();
  fd.append('file', fileEl.files[0]);
  const company = window.currentCompany || 'assessoria';
  const token   = localStorage.getItem('montana_token') || '';
  showLoading('Importando registros de ponto…');
  try {
    const resp = await fetch('/api/ponto/importar', { method:'POST', body: fd, headers:{ 'X-Company': company, 'Authorization': `Bearer ${token}` } });
    const res  = await resp.json();
    if (res.ok) {
      let msg = `✔ ${res.inseridos} registros importados`;
      if (res.duplicados > 0) msg += ` · ${res.duplicados} duplicados ignorados`;
      if (res.erros && res.erros.length > 0) msg += ` · ${res.erros.length} erros`;
      toast(msg);
      if (res.erros && res.erros.length > 0) {
        document.getElementById('ponto-import-erros').innerHTML =
          `<div style="margin-top:8px;background:#fee2e2;border:1px solid #fca5a5;border-radius:6px;padding:8px;font-size:10px;color:#dc2626">
            <strong>Erros:</strong><br>${res.erros.join('<br>')}
          </div>`;
      } else {
        document.getElementById('ponto-import-erros').innerHTML = '';
      }
      loadPontoRegistros();
    } else toast(res.error || 'Erro na importação', 'erro');
  } finally { hideLoading(); }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _formatarData(str) {
  if (!str) return '—';
  const [y, m, d] = str.split('-');
  return `${d}/${m}/${y}`;
}

function _ocTipoLabel(tipo) {
  const L = {
    falta_justificada:'Falta Justif.',falta_injustificada:'Falta Injustif.',
    atraso:'Atraso',licenca_medica:'Lic. Médica',ferias:'Férias',
    afastamento_inss:'Afastamento INSS',licenca_maternidade:'Lic. Maternidade',
    folga_compensatoria:'Folga Comp.',declaracao:'Declaração',
  };
  return L[tipo] || tipo;
}
