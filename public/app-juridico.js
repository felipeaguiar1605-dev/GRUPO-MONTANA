// ═══════════════════════════════════════════════════════════════
//  MÓDULO JURÍDICO — Ofícios, Processos, Riscos Contratuais
// ═══════════════════════════════════════════════════════════════

function jurApi(url, opts) { return api('/juridico' + url, opts); }

const JUR_STATUS_OFICIO   = { PENDENTE: { label: 'Pendente',  cor: '#dc2626', bg: '#fef2f2' }, RESPONDIDO: { label: 'Respondido', cor: '#16a34a', bg: '#f0fdf4' }, ARQUIVADO: { label: 'Arquivado', cor: '#6b7280', bg: '#f1f5f9' } };
const JUR_TIPO_PROCESSO   = { JUDICIAL: '⚖️ Judicial', ADMINISTRATIVO: '🏛️ Administrativo', TCU: '🔍 TCU', TCE: '🔍 TCE', CGU: '🔍 CGU', TRABALHISTA: '👷 Trabalhista' };
const JUR_PROB            = { BAIXA: { label: 'Baixa', cor: '#16a34a' }, MEDIA: { label: 'Média', cor: '#d97706' }, ALTA: { label: 'Alta', cor: '#dc2626' } };
const JUR_IMPACTO         = { BAIXO: { label: 'Baixo', cor: '#16a34a' }, MEDIO: { label: 'Médio', cor: '#d97706' }, ALTO: { label: 'Alto', cor: '#dc2626' } };

function jurShowView(v) {
  ['dashboard','oficios','processos','riscos','novo-oficio','novo-processo','novo-risco'].forEach(id => {
    const el = document.getElementById('jur-view-' + id);
    if (el) el.style.display = id === v ? '' : 'none';
    const btn = document.getElementById('jur-btn-' + id);
    if (btn) btn.classList.toggle('active-est', id === v);
  });
  if (v === 'dashboard')    jurCarregarDashboard();
  if (v === 'oficios')      jurCarregarOficios();
  if (v === 'processos')    jurCarregarProcessos();
  if (v === 'riscos')       jurCarregarRiscos();
}

// ── DASHBOARD ──────────────────────────────────────────────────
async function jurCarregarDashboard() {
  try {
    const d = await jurApi('/resumo');
    const r = d.resumo;
    const hoje = new Date().toISOString().slice(0,10);

    // KPI cards
    document.getElementById('jur-kpis').innerHTML = [
      { label: 'Ofícios Pendentes',   val: r.oficiosPendentes,  cor: '#0369a1', bg: '#eff6ff', icon: '📬' },
      { label: 'Ofícios Vencidos',    val: r.oficiosVencidos,   cor: '#dc2626', bg: '#fef2f2', icon: '⏰' },
      { label: 'Processos Ativos',    val: r.processosAtivos,   cor: '#7c3aed', bg: '#f5f3ff', icon: '⚖️' },
      { label: 'Audiências (30 dias)',val: r.audienciasEm30,    cor: '#d97706', bg: '#fffbeb', icon: '📅' },
      { label: 'Riscos Altos',        val: r.riscosAltos,       cor: '#dc2626', bg: '#fef2f2', icon: '🔴' },
      { label: 'Valor em Risco',      val: 'R$ '+(r.valorRiscoTotal||0).toLocaleString('pt-BR',{minimumFractionDigits:0}), cor: '#b45309', bg: '#fffbeb', icon: '💰' },
    ].map(c => `<div style="background:${c.bg};border:1px solid ${c.cor}30;border-radius:10px;padding:12px 16px;cursor:pointer">
      <div style="font-size:.72rem;color:#6b7280">${c.icon} ${c.label}</div>
      <div style="font-size:1.5rem;font-weight:700;color:${c.cor}">${c.val}</div>
    </div>`).join('');

    // Alertas ofícios
    const aoDiv = document.getElementById('jur-alertas-oficios');
    aoDiv.innerHTML = !d.alertas_oficios.length
      ? '<div style="color:#16a34a;font-size:.83rem;padding:8px">✅ Nenhum ofício vencido ou urgente</div>'
      : d.alertas_oficios.map(o => {
          const venc = o.data_prazo < hoje;
          return `<div style="background:${venc?'#fef2f2':'#fffbeb'};border:1px solid ${venc?'#fecaca':'#fde68a'};border-radius:6px;padding:8px 12px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;cursor:pointer" onclick="jurAbrirOficio(${o.id})">
            <div>
              <div style="font-weight:600;font-size:.85rem">${o.orgao}${o.numero?` — Nº ${o.numero}`:''}</div>
              <div style="font-size:.75rem;color:#6b7280">${o.assunto.slice(0,60)}${o.assunto.length>60?'...':''}</div>
            </div>
            <div style="text-align:right;white-space:nowrap">
              <div style="font-weight:700;color:${venc?'#dc2626':'#d97706'};font-size:.82rem">${venc?'⏰ VENCIDO':'⚠️ URGENTE'}</div>
              <div style="font-size:.72rem;color:#6b7280">Prazo: ${o.data_prazo||'—'}</div>
            </div>
          </div>`;
        }).join('');

    // Audiências próximas
    const audDiv = document.getElementById('jur-audiencias');
    audDiv.innerHTML = !d.audiencias_proximas.length
      ? '<div style="color:#6b7280;font-size:.83rem;padding:8px">Nenhuma audiência nos próximos 30 dias</div>'
      : d.audiencias_proximas.map(p => `
          <div style="border-bottom:1px solid #f1f5f9;padding:8px 0;display:flex;justify-content:space-between;cursor:pointer" onclick="jurAbrirProcesso(${p.id})">
            <div>
              <div style="font-weight:600;font-size:.83rem">${JUR_TIPO_PROCESSO[p.tipo]||p.tipo} — ${p.orgao}</div>
              <div style="font-size:.75rem;color:#6b7280">${p.assunto.slice(0,55)}${p.assunto.length>55?'...':''}</div>
            </div>
            <div style="text-align:right;white-space:nowrap">
              <div style="font-weight:700;color:#7c3aed;font-size:.82rem">📅 ${p.proxima_audiencia}</div>
              ${p.valor_risco?`<div style="font-size:.72rem;color:#b45309">R$ ${p.valor_risco.toLocaleString('pt-BR',{minimumFractionDigits:2})}</div>`:''}
            </div>
          </div>`).join('');

    // Riscos altos
    const riscDiv = document.getElementById('jur-riscos-dash');
    riscDiv.innerHTML = !d.riscos_altos.length
      ? '<div style="color:#16a34a;font-size:.83rem;padding:8px">✅ Nenhum risco alto identificado</div>'
      : d.riscos_altos.map(r => `
          <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:8px 12px;margin-bottom:6px">
            <div style="display:flex;justify-content:space-between">
              <div style="font-weight:600;font-size:.83rem">🔴 ${r.contrato_ref} — ${r.tipo}</div>
              ${r.valor_estimado?`<div style="font-weight:700;color:#dc2626;font-size:.82rem">R$ ${r.valor_estimado.toLocaleString('pt-BR',{minimumFractionDigits:2})}</div>`:''}
            </div>
            <div style="font-size:.75rem;color:#6b7280;margin-top:2px">${r.descricao.slice(0,80)}${r.descricao.length>80?'...':''}</div>
            ${r.mitigacao?`<div style="font-size:.72rem;color:#16a34a;margin-top:3px">🛡️ ${r.mitigacao.slice(0,60)}</div>`:''}
          </div>`).join('');

  } catch(e) { console.error('jur dashboard:', e); }
}

// ── OFÍCIOS ────────────────────────────────────────────────────
async function jurCarregarOficios() {
  const busca   = document.getElementById('jur-of-busca')?.value || '';
  const status  = document.getElementById('jur-of-status')?.value || '';
  const params  = new URLSearchParams();
  if (busca)  params.set('busca', busca);
  if (status) params.set('status', status);
  try {
    const lista = await jurApi('/oficios?' + params);
    const hoje = new Date().toISOString().slice(0,10);
    const wrap = document.getElementById('jur-oficios-table');
    if (!lista.length) { wrap.innerHTML = '<div style="padding:20px;text-align:center;color:#6b7280">Nenhum ofício encontrado</div>'; return; }
    wrap.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:.82rem">
      <thead><tr style="background:#f8fafc">
        <th style="padding:7px 8px;text-align:left;border-bottom:2px solid #e2e8f0">Nº / Órgão</th>
        <th style="padding:7px 8px;text-align:left;border-bottom:2px solid #e2e8f0">Assunto</th>
        <th style="padding:7px 8px;text-align:left;border-bottom:2px solid #e2e8f0">Tipo</th>
        <th style="padding:7px 8px;text-align:left;border-bottom:2px solid #e2e8f0">Contrato</th>
        <th style="padding:7px 8px;text-align:center;border-bottom:2px solid #e2e8f0">Prazo</th>
        <th style="padding:7px 8px;text-align:center;border-bottom:2px solid #e2e8f0">Status</th>
        <th style="padding:7px 8px;border-bottom:2px solid #e2e8f0"></th>
      </tr></thead><tbody>
      ${lista.map(o => {
        const s = JUR_STATUS_OFICIO[o.status] || { label: o.status, cor: '#374151', bg: '#f1f5f9' };
        const venc = o.status === 'PENDENTE' && o.data_prazo && o.data_prazo < hoje;
        return `<tr style="border-bottom:1px solid #f1f5f9;${venc?'background:#fef2f2':''}">
          <td style="padding:6px 8px;font-weight:500">${o.numero||'—'}<div style="font-size:.75rem;color:#6b7280">${o.orgao}</div></td>
          <td style="padding:6px 8px;max-width:220px">${o.assunto.slice(0,60)}${o.assunto.length>60?'...':''}</td>
          <td style="padding:6px 8px;font-size:.78rem">${o.tipo==='RECEBIDO'?'📥 Recebido':'📤 Enviado'}</td>
          <td style="padding:6px 8px;font-size:.75rem;color:#6b7280">${o.contrato_ref||'—'}</td>
          <td style="padding:6px 8px;text-align:center;font-size:.78rem;${venc?'color:#dc2626;font-weight:700':'color:#374151'}">${o.data_prazo||(o.status==='PENDENTE'?'⚠️ S/ prazo':'—')}</td>
          <td style="padding:6px 8px;text-align:center"><span style="background:${s.bg};color:${s.cor};padding:2px 8px;border-radius:12px;font-size:.75rem;font-weight:600">${s.label}</span></td>
          <td style="padding:6px 8px;white-space:nowrap">
            <button onclick="jurAbrirOficio(${o.id})" style="background:#e0f2fe;color:#0369a1;border:none;padding:3px 8px;border-radius:4px;font-size:.75rem;cursor:pointer">✏️</button>
            ${o.status==='PENDENTE'?`<button onclick="jurResponderOficio(${o.id})" style="background:#dcfce7;color:#16a34a;border:none;padding:3px 8px;border-radius:4px;font-size:.75rem;cursor:pointer;margin-left:3px">✅ Resp.</button>`:''}
          </td>
        </tr>`;
      }).join('')}
      </tbody></table>`;
  } catch(e) { console.error(e); }
}

function jurNovoOficioForm(o) {
  jurShowView('novo-oficio');
  const hoje = new Date().toISOString().slice(0,10);
  document.getElementById('jur-of-form-id').value       = o?.id || '';
  document.getElementById('jur-of-form-num').value      = o?.numero || '';
  document.getElementById('jur-of-form-tipo').value     = o?.tipo || 'RECEBIDO';
  document.getElementById('jur-of-form-orgao').value    = o?.orgao || '';
  document.getElementById('jur-of-form-assunto').value  = o?.assunto || '';
  document.getElementById('jur-of-form-contrato').value = o?.contrato_ref || '';
  document.getElementById('jur-of-form-receb').value    = o?.data_recebimento || hoje;
  document.getElementById('jur-of-form-prazo').value    = o?.data_prazo || '';
  document.getElementById('jur-of-form-resp').value     = o?.responsavel || '';
  document.getElementById('jur-of-form-prior').value    = o?.prioridade || 'NORMAL';
  document.getElementById('jur-of-form-valor').value    = o?.valor_risco || '';
  document.getElementById('jur-of-form-obs').value      = o?.obs || '';
}

async function jurAbrirOficio(id) {
  try {
    const lista = await jurApi('/oficios?busca=');
    const o = (await jurApi('/oficios')).find ? null : null;
    const todos = await jurApi('/oficios');
    const oficio = todos.find(x => x.id === id);
    if (oficio) jurNovoOficioForm(oficio);
  } catch(e) { console.error(e); }
}

async function jurSalvarOficio() {
  const id = document.getElementById('jur-of-form-id').value;
  const body = {
    numero:           document.getElementById('jur-of-form-num').value,
    tipo:             document.getElementById('jur-of-form-tipo').value,
    orgao:            document.getElementById('jur-of-form-orgao').value,
    assunto:          document.getElementById('jur-of-form-assunto').value,
    contrato_ref:     document.getElementById('jur-of-form-contrato').value,
    data_recebimento: document.getElementById('jur-of-form-receb').value,
    data_prazo:       document.getElementById('jur-of-form-prazo').value,
    responsavel:      document.getElementById('jur-of-form-resp').value,
    prioridade:       document.getElementById('jur-of-form-prior').value,
    valor_risco:      document.getElementById('jur-of-form-valor').value,
    obs:              document.getElementById('jur-of-form-obs').value,
  };
  if (!body.orgao || !body.assunto) { alert('Órgão e assunto são obrigatórios'); return; }
  try {
    const url = id ? `/oficios/${id}` : '/oficios';
    const d = await jurApi(url, { method: id ? 'PUT' : 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    if (d.error) { alert(d.error); return; }
    alert('✅ ' + d.message);
    jurShowView('oficios');
  } catch(e) { alert('Erro: ' + e.message); }
}

async function jurResponderOficio(id) {
  const data = prompt('Data de resposta (AAAA-MM-DD):', new Date().toISOString().slice(0,10));
  if (!data) return;
  const obs = prompt('Observação (opcional):') || '';
  try {
    const d = await jurApi(`/oficios/${id}/status`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ status: 'RESPONDIDO', data_resposta: data, obs }) });
    if (d.error) { alert(d.error); return; }
    alert('✅ Ofício marcado como respondido');
    jurCarregarOficios();
  } catch(e) { alert('Erro: ' + e.message); }
}

// ── PROCESSOS ──────────────────────────────────────────────────
async function jurCarregarProcessos() {
  const busca  = document.getElementById('jur-pr-busca')?.value || '';
  const status = document.getElementById('jur-pr-status')?.value || '';
  const tipo   = document.getElementById('jur-pr-tipo')?.value || '';
  const params = new URLSearchParams();
  if (busca)  params.set('busca', busca);
  if (status) params.set('status', status);
  if (tipo)   params.set('tipo', tipo);
  try {
    const lista = await jurApi('/processos?' + params);
    const wrap = document.getElementById('jur-processos-table');
    if (!lista.length) { wrap.innerHTML = '<div style="padding:20px;text-align:center;color:#6b7280">Nenhum processo encontrado</div>'; return; }
    wrap.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:.82rem">
      <thead><tr style="background:#f8fafc">
        <th style="padding:7px 8px;text-align:left;border-bottom:2px solid #e2e8f0">Número / Tipo</th>
        <th style="padding:7px 8px;text-align:left;border-bottom:2px solid #e2e8f0">Órgão / Vara</th>
        <th style="padding:7px 8px;text-align:left;border-bottom:2px solid #e2e8f0">Assunto</th>
        <th style="padding:7px 8px;text-align:left;border-bottom:2px solid #e2e8f0">Contrato</th>
        <th style="padding:7px 8px;text-align:center;border-bottom:2px solid #e2e8f0">Próx. Audiência</th>
        <th style="padding:7px 8px;text-align:right;border-bottom:2px solid #e2e8f0">Valor Risco</th>
        <th style="padding:7px 8px;text-align:center;border-bottom:2px solid #e2e8f0">Prob.</th>
        <th style="padding:7px 8px;border-bottom:2px solid #e2e8f0"></th>
      </tr></thead><tbody>
      ${lista.map(p => {
        const prob = JUR_PROB[p.probabilidade] || { label: p.probabilidade, cor: '#374151' };
        return `<tr style="border-bottom:1px solid #f1f5f9;${p.status!=='ATIVO'?'opacity:.6':''}">
          <td style="padding:6px 8px">
            <div style="font-weight:500;font-size:.78rem">${JUR_TIPO_PROCESSO[p.tipo]||p.tipo}</div>
            <div style="font-size:.72rem;color:#6b7280;font-family:monospace">${p.numero||'S/ número'}</div>
          </td>
          <td style="padding:6px 8px;font-size:.78rem">${p.orgao}${p.vara?`<div style="font-size:.72rem;color:#6b7280">${p.vara}</div>`:''}</td>
          <td style="padding:6px 8px;max-width:200px;font-size:.78rem">${p.assunto.slice(0,55)}${p.assunto.length>55?'...':''}</td>
          <td style="padding:6px 8px;font-size:.75rem;color:#6b7280">${p.contrato_ref||'—'}</td>
          <td style="padding:6px 8px;text-align:center;font-size:.78rem;color:#7c3aed;font-weight:600">${p.proxima_audiencia||'—'}</td>
          <td style="padding:6px 8px;text-align:right;font-weight:600;color:#b45309">${p.valor_risco?'R$ '+p.valor_risco.toLocaleString('pt-BR',{minimumFractionDigits:2}):'—'}</td>
          <td style="padding:6px 8px;text-align:center"><span style="color:${prob.cor};font-weight:700;font-size:.78rem">● ${prob.label}</span></td>
          <td style="padding:6px 8px;white-space:nowrap">
            <button onclick="jurAbrirProcesso(${p.id})" style="background:#e0f2fe;color:#0369a1;border:none;padding:3px 8px;border-radius:4px;font-size:.75rem;cursor:pointer">✏️</button>
            <button onclick="jurNovoAndamento(${p.id})" style="background:#f5f3ff;color:#7c3aed;border:none;padding:3px 8px;border-radius:4px;font-size:.75rem;cursor:pointer;margin-left:3px">+ And.</button>
          </td>
        </tr>`;
      }).join('')}
      </tbody></table>`;
  } catch(e) { console.error(e); }
}

function jurNovoProcessoForm(p) {
  jurShowView('novo-processo');
  document.getElementById('jur-pr-form-id').value         = p?.id || '';
  document.getElementById('jur-pr-form-num').value        = p?.numero || '';
  document.getElementById('jur-pr-form-tipo').value       = p?.tipo || 'JUDICIAL';
  document.getElementById('jur-pr-form-orgao').value      = p?.orgao || '';
  document.getElementById('jur-pr-form-vara').value       = p?.vara || '';
  document.getElementById('jur-pr-form-assunto').value    = p?.assunto || '';
  document.getElementById('jur-pr-form-contrato').value   = p?.contrato_ref || '';
  document.getElementById('jur-pr-form-autor').value      = p?.autor || '';
  document.getElementById('jur-pr-form-reu').value        = p?.reu || '';
  document.getElementById('jur-pr-form-abertura').value   = p?.data_abertura || '';
  document.getElementById('jur-pr-form-audiencia').value  = p?.proxima_audiencia || '';
  document.getElementById('jur-pr-form-advogado').value   = p?.advogado || '';
  document.getElementById('jur-pr-form-fase').value       = p?.fase || '';
  document.getElementById('jur-pr-form-vcausa').value     = p?.valor_causa || '';
  document.getElementById('jur-pr-form-vrisco').value     = p?.valor_risco || '';
  document.getElementById('jur-pr-form-prob').value       = p?.probabilidade || 'MEDIA';
  document.getElementById('jur-pr-form-obs').value        = p?.obs || '';
}

async function jurAbrirProcesso(id) {
  try {
    const todos = await jurApi('/processos');
    const proc = todos.find(x => x.id === id);
    if (proc) jurNovoProcessoForm(proc);
  } catch(e) { console.error(e); }
}

async function jurSalvarProcesso() {
  const id = document.getElementById('jur-pr-form-id').value;
  const body = {
    numero:            document.getElementById('jur-pr-form-num').value,
    tipo:              document.getElementById('jur-pr-form-tipo').value,
    orgao:             document.getElementById('jur-pr-form-orgao').value,
    vara:              document.getElementById('jur-pr-form-vara').value,
    assunto:           document.getElementById('jur-pr-form-assunto').value,
    contrato_ref:      document.getElementById('jur-pr-form-contrato').value,
    autor:             document.getElementById('jur-pr-form-autor').value,
    reu:               document.getElementById('jur-pr-form-reu').value,
    data_abertura:     document.getElementById('jur-pr-form-abertura').value,
    proxima_audiencia: document.getElementById('jur-pr-form-audiencia').value,
    advogado:          document.getElementById('jur-pr-form-advogado').value,
    fase:              document.getElementById('jur-pr-form-fase').value,
    valor_causa:       document.getElementById('jur-pr-form-vcausa').value,
    valor_risco:       document.getElementById('jur-pr-form-vrisco').value,
    probabilidade:     document.getElementById('jur-pr-form-prob').value,
    obs:               document.getElementById('jur-pr-form-obs').value,
    status: 'ATIVO'
  };
  if (!body.tipo || !body.orgao || !body.assunto) { alert('Tipo, órgão e assunto são obrigatórios'); return; }
  try {
    const url = id ? `/processos/${id}` : '/processos';
    const d = await jurApi(url, { method: id ? 'PUT' : 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    if (d.error) { alert(d.error); return; }
    alert('✅ ' + d.message);
    jurShowView('processos');
  } catch(e) { alert('Erro: ' + e.message); }
}

async function jurNovoAndamento(processoId) {
  const data = prompt('Data do andamento (AAAA-MM-DD):', new Date().toISOString().slice(0,10));
  if (!data) return;
  const descricao = prompt('Descrição do andamento:');
  if (!descricao) return;
  const responsavel = prompt('Responsável (opcional):') || '';
  const proxima = prompt('Próxima audiência (AAAA-MM-DD, deixe em branco para não alterar):') || '';
  try {
    const d = await jurApi(`/processos/${processoId}/andamentos`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ data, descricao, responsavel, proxima_audiencia: proxima||undefined })
    });
    if (d.error) { alert(d.error); return; }
    alert('✅ Andamento registrado');
    jurCarregarProcessos();
  } catch(e) { alert('Erro: ' + e.message); }
}

// ── RISCOS CONTRATUAIS ─────────────────────────────────────────
async function jurCarregarRiscos() {
  const contrato = document.getElementById('jur-ri-contrato')?.value || '';
  const prob     = document.getElementById('jur-ri-prob')?.value || '';
  const params   = new URLSearchParams();
  if (contrato) params.set('contrato_ref', contrato);
  if (prob)     params.set('probabilidade', prob);
  try {
    const lista = await jurApi('/riscos?' + params);
    const wrap = document.getElementById('jur-riscos-table');
    if (!lista.length) { wrap.innerHTML = '<div style="padding:20px;text-align:center;color:#6b7280">Nenhum risco cadastrado</div>'; return; }

    // Agrupar por contrato
    const porContrato = {};
    lista.forEach(r => {
      if (!porContrato[r.contrato_ref]) porContrato[r.contrato_ref] = [];
      porContrato[r.contrato_ref].push(r);
    });

    wrap.innerHTML = Object.entries(porContrato).map(([contrato, riscos]) => {
      const totalRisco = riscos.reduce((s,r) => s + (r.valor_estimado||0), 0);
      return `<div style="border:1px solid #e2e8f0;border-radius:8px;margin-bottom:12px;overflow:hidden">
        <div style="background:#f8fafc;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #e2e8f0">
          <div style="font-weight:700;color:#0f172a">📋 ${contrato}</div>
          <div style="font-size:.8rem;color:#b45309;font-weight:600">${totalRisco>0?'Exposição: R$ '+totalRisco.toLocaleString('pt-BR',{minimumFractionDigits:2}):''}</div>
        </div>
        ${riscos.map(r => {
          const prob = JUR_PROB[r.probabilidade] || { label: r.probabilidade, cor: '#374151' };
          const imp  = JUR_IMPACTO[r.impacto]   || { label: r.impacto,       cor: '#374151' };
          const alto = r.probabilidade==='ALTA' || r.impacto==='ALTO';
          return `<div style="padding:10px 14px;border-bottom:1px solid #f1f5f9;${alto?'background:#fffafa':''}">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
              <div style="flex:1">
                <div style="font-weight:600;font-size:.83rem">${r.tipo}</div>
                <div style="font-size:.78rem;color:#374151;margin-top:2px">${r.descricao}</div>
                ${r.mitigacao?`<div style="font-size:.75rem;color:#16a34a;margin-top:3px">🛡️ ${r.mitigacao}</div>`:''}
              </div>
              <div style="text-align:right;white-space:nowrap;flex-shrink:0">
                <div style="font-size:.75rem"><span style="color:${prob.cor};font-weight:700">● ${prob.label}</span> / <span style="color:${imp.cor};font-weight:700">${imp.label}</span></div>
                ${r.valor_estimado?`<div style="color:#b45309;font-weight:700;font-size:.82rem">R$ ${r.valor_estimado.toLocaleString('pt-BR',{minimumFractionDigits:2})}</div>`:''}
                <div style="margin-top:4px">
                  <button onclick="jurAbrirRisco(${r.id})" style="background:#e0f2fe;color:#0369a1;border:none;padding:2px 7px;border-radius:4px;font-size:.72rem;cursor:pointer">✏️</button>
                  ${r.status!=='MITIGADO'?`<button onclick="jurMitigarRisco(${r.id})" style="background:#dcfce7;color:#16a34a;border:none;padding:2px 7px;border-radius:4px;font-size:.72rem;cursor:pointer;margin-left:3px">🛡️</button>`:''}
                </div>
              </div>
            </div>
          </div>`;
        }).join('')}
      </div>`;
    }).join('');
  } catch(e) { console.error(e); }
}

function jurNovoRiscoForm(r) {
  jurShowView('novo-risco');
  document.getElementById('jur-ri-form-id').value        = r?.id || '';
  document.getElementById('jur-ri-form-contrato').value  = r?.contrato_ref || '';
  document.getElementById('jur-ri-form-tipo').value      = r?.tipo || '';
  document.getElementById('jur-ri-form-desc').value      = r?.descricao || '';
  document.getElementById('jur-ri-form-prob').value      = r?.probabilidade || 'MEDIA';
  document.getElementById('jur-ri-form-impacto').value   = r?.impacto || 'MEDIO';
  document.getElementById('jur-ri-form-valor').value     = r?.valor_estimado || '';
  document.getElementById('jur-ri-form-mitig').value     = r?.mitigacao || '';
  document.getElementById('jur-ri-form-resp').value      = r?.responsavel || '';
  document.getElementById('jur-ri-form-obs').value       = r?.obs || '';
}

async function jurAbrirRisco(id) {
  try {
    const todos = await jurApi('/riscos');
    const risco = todos.find(x => x.id === id);
    if (risco) jurNovoRiscoForm(risco);
  } catch(e) { console.error(e); }
}

async function jurSalvarRisco() {
  const id = document.getElementById('jur-ri-form-id').value;
  const body = {
    contrato_ref:      document.getElementById('jur-ri-form-contrato').value,
    tipo:              document.getElementById('jur-ri-form-tipo').value,
    descricao:         document.getElementById('jur-ri-form-desc').value,
    probabilidade:     document.getElementById('jur-ri-form-prob').value,
    impacto:           document.getElementById('jur-ri-form-impacto').value,
    valor_estimado:    document.getElementById('jur-ri-form-valor').value,
    mitigacao:         document.getElementById('jur-ri-form-mitig').value,
    responsavel:       document.getElementById('jur-ri-form-resp').value,
    obs:               document.getElementById('jur-ri-form-obs').value,
    status: 'IDENTIFICADO'
  };
  if (!body.contrato_ref || !body.tipo || !body.descricao) { alert('Contrato, tipo e descrição são obrigatórios'); return; }
  try {
    const url = id ? `/riscos/${id}` : '/riscos';
    const d = await jurApi(url, { method: id ? 'PUT' : 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    if (d.error) { alert(d.error); return; }
    alert('✅ ' + d.message);
    jurShowView('riscos');
  } catch(e) { alert('Erro: ' + e.message); }
}

async function jurMitigarRisco(id) {
  const mitigacao = prompt('Descreva a medida de mitigação adotada:');
  if (!mitigacao) return;
  try {
    const todos = await jurApi('/riscos');
    const r = todos.find(x => x.id === id);
    if (!r) return;
    const d = await jurApi(`/riscos/${id}`, {
      method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ ...r, mitigacao, status: 'MITIGADO', data_revisao: new Date().toISOString().slice(0,10) })
    });
    if (d.error) { alert(d.error); return; }
    alert('✅ Risco marcado como mitigado');
    jurCarregarRiscos();
  } catch(e) { alert('Erro: ' + e.message); }
}

window.juridicoInit = function() { jurShowView('dashboard'); };
