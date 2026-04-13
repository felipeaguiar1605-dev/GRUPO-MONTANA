/**
 * Montana ERP — Assistente IA + Google Drive
 * Requer: /api/ia/* e /api/drive/* no backend
 */

// ── Estado ────────────────────────────────────────────────────────
let iaHistorico   = [];
let iaAberto      = false;
let driveConectado = false;

// ── Init ──────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  iaCheckStatus();
  driveCheckStatus();
  // Ouve callback OAuth Drive (popup fecha e manda postMessage)
  window.addEventListener('message', e => {
    if (e.data === 'drive_conectado') {
      driveConectado = true;
      driveCheckStatus();
      showToast('Google Drive conectado com sucesso!');
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  ASSISTENTE IA
// ══════════════════════════════════════════════════════════════════

function iaToggle() {
  const sidebar = document.getElementById('ia-sidebar');
  const drivePainel = document.getElementById('ia-drive-panel');
  iaAberto = !iaAberto;
  sidebar.style.display = iaAberto ? 'flex' : 'none';
  if (iaAberto) {
    drivePainel.style.display = 'none';
    if (iaHistorico.length === 0) iaBoasVindas();
    setTimeout(() => document.getElementById('ia-input')?.focus(), 100);
  }
}

function iaDrivePanel() {
  const sidebar = document.getElementById('ia-sidebar');
  const painel  = document.getElementById('ia-drive-panel');
  sidebar.style.display = 'none';
  iaAberto = false;
  const abrindo = painel.style.display !== 'flex';
  painel.style.display = abrindo ? 'flex' : 'none';
  if (abrindo) driveCheckStatus(); // atualiza status ao abrir
}

async function iaCheckStatus() {
  try {
    const r = await api('/ia/status', { method: 'GET' });
    if (!r.configurado) {
      // Deixa FAB com visual "dormente" mas funcional
      const fab = document.getElementById('ia-fab');
      if (fab) fab.style.opacity = '0.6';
    }
  } catch (_) {}
}

async function iaBoasVindas() {
  try {
    const r = await api('/ia/status', { method: 'GET' });
    if (!r.configurado) {
      iaAdicionarMsg('assistant',
        '⚙️ **Assistente IA não configurado ainda.**\n\n' +
        'Para ativar, o administrador precisa adicionar a chave `ANTHROPIC_API_KEY` no arquivo `.env` do servidor.\n\n' +
        'Enquanto isso, o Google Drive pode ser configurado independentemente clicando em **☁ Drive**.'
      );
    } else {
      iaAdicionarMsg('assistant',
        `Olá! Sou o assistente financeiro do Montana ERP. Posso responder perguntas sobre **${currentCompany ? currentCompany.toUpperCase() : 'sua empresa'}**.\n\nO que deseja saber?`
      );
    }
  } catch (_) {
    iaAdicionarMsg('assistant', 'Olá! Como posso ajudar?');
  }
}

async function iaEnviar(mensagemFixa) {
  const input = document.getElementById('ia-input');
  const mensagem = mensagemFixa || input?.value?.trim();
  if (!mensagem) return;

  if (input) input.value = '';
  document.getElementById('ia-chips').style.display = 'none';

  iaAdicionarMsg('user', mensagem);
  const loading = iaAdicionarMsg('assistant', '…', true);

  try {
    const r = await api('/ia/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mensagem, historico: iaHistorico.slice(-10) }),
    });

    loading.remove();

    if (r.ok) {
      iaHistorico.push({ role: 'user', content: mensagem });
      iaHistorico.push({ role: 'assistant', content: r.resposta });
      iaAdicionarMsg('assistant', r.resposta);
    } else {
      iaAdicionarMsg('assistant', r.resposta || `Erro: ${r.erro || 'desconhecido'}`);
    }
  } catch (e) {
    loading.remove();
    iaAdicionarMsg('assistant', `Erro de conexão: ${e.message}`);
  }
}

function iaAdicionarMsg(role, texto, loading = false) {
  const container = document.getElementById('ia-msgs');
  const div = document.createElement('div');
  div.style.cssText = `
    max-width:88%;padding:9px 12px;border-radius:12px;font-size:12px;line-height:1.5;
    ${role === 'user'
      ? 'background:#6366f1;color:#fff;align-self:flex-end;border-bottom-right-radius:3px'
      : 'background:#f1f5f9;color:#1e293b;align-self:flex-start;border-bottom-left-radius:3px'}
  `;

  if (loading) {
    div.innerHTML = '<span style="opacity:.6">Pensando…</span>';
  } else {
    // Markdown simples: **bold**, `code`, quebras de linha
    div.innerHTML = texto
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code style="background:rgba(0,0,0,.08);padding:1px 4px;border-radius:3px">$1</code>')
      .replace(/\n/g, '<br>');
  }

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

// ══════════════════════════════════════════════════════════════════
//  GOOGLE DRIVE
// ══════════════════════════════════════════════════════════════════

async function driveCheckStatus() {
  const bar = document.getElementById('ia-drive-status-bar');
  const btn = document.getElementById('drive-connect-btn');
  try {
    const r = await api('/drive/status', { method: 'GET' });
    driveConectado = r.conectado;

    if (bar) bar.textContent = r.mensagem || (r.conectado ? '✅ Conectado' : '⚠ Não conectado');
    if (btn) {
      btn.textContent = r.conectado ? 'Desconectar' : 'Conectar Drive';
      btn.onclick = r.conectado ? driveDesconectar : driveConectar;
      btn.style.background = r.conectado ? '#fee2e2' : '#f1f5f9';
      btn.style.color = r.conectado ? '#dc2626' : '#475569';
    }
  } catch (_) {
    if (bar) bar.textContent = 'Erro ao verificar status';
  }
}

function driveConectar() {
  if (!driveConectado) {
    // Passa token e empresa via query params (popup não envia headers)
    const token   = localStorage.getItem('montana_jwt') || '';
    const company = currentCompany || localStorage.getItem('montana_company') || 'assessoria';
    const url = `/api/drive/auth?token=${encodeURIComponent(token)}&company=${encodeURIComponent(company)}`;
    window.open(url, 'drive_oauth', 'width=500,height=600');
  }
}

async function driveDesconectar() {
  if (!confirm('Desconectar o Google Drive desta empresa?')) return;
  await api('/drive/desconectar', { method: 'DELETE' });
  driveConectado = false;
  driveCheckStatus();
  document.getElementById('ia-drive-results').innerHTML = '';
  showToast('Google Drive desconectado.');
}

async function driveBuscar() {
  const termo = document.getElementById('drive-busca')?.value?.trim() || '';
  const results = document.getElementById('ia-drive-results');
  results.innerHTML = '<div style="text-align:center;padding:20px;color:#94a3b8;font-size:12px">Buscando…</div>';

  try {
    const r = await api('/drive/buscar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ termo }),
    });

    if (!r.ok) {
      results.innerHTML = `<div style="padding:12px;font-size:12px;color:#64748b">${
        !r.configurado ? '⚙️ Google Drive não configurado no servidor.' :
        !r.conectado   ? '🔗 Conecte o Google Drive primeiro.' :
        `Erro: ${r.erro || 'desconhecido'}`
      }</div>`;
      return;
    }

    if (!r.arquivos?.length) {
      results.innerHTML = '<div style="padding:12px;font-size:12px;color:#64748b">Nenhum arquivo encontrado.</div>';
      return;
    }

    results.innerHTML = r.arquivos.map(f => {
      const icone = f.tipo?.includes('spreadsheet') ? '📊'
                  : f.tipo?.includes('pdf')          ? '📄'
                  : f.tipo?.includes('document')     ? '📝'
                  : f.tipo?.includes('folder')       ? '📁' : '📎';
      return `
        <div style="padding:8px;border-bottom:1px solid #f1f5f9;cursor:pointer"
             onclick="window.open('${f.link}','_blank')">
          <div style="font-size:12px;font-weight:600;color:#1e293b">${icone} ${f.nome}</div>
          ${f.resumo_ia ? `<div style="font-size:11px;color:#64748b;margin-top:2px">${f.resumo_ia}</div>` : ''}
          <div style="font-size:10px;color:#94a3b8;margin-top:2px">${f.modificado} ${f.tamanho ? '· ' + f.tamanho : ''}</div>
        </div>`;
    }).join('');
  } catch (e) {
    results.innerHTML = `<div style="padding:12px;font-size:12px;color:#ef4444">Erro: ${e.message}</div>`;
  }
}

async function driveSugestoes() {
  const results = document.getElementById('ia-drive-results');
  results.innerHTML = '<div style="text-align:center;padding:20px;color:#94a3b8;font-size:12px">Analisando documentos com IA…</div>';

  try {
    const r = await api('/drive/sugestoes', { method: 'GET' });

    if (!r.ok) {
      results.innerHTML = `<div style="padding:12px;font-size:12px;color:#64748b">${
        !r.configurado    ? '⚙️ Google Drive não configurado.' :
        !r.ia_configurada ? '⚙️ IA não configurada (ANTHROPIC_API_KEY ausente).' :
        !r.conectado      ? '🔗 Conecte o Google Drive primeiro.' :
        `Erro: ${r.erro || 'desconhecido'}`
      }</div>`;
      return;
    }

    if (!r.sugestoes?.length) {
      results.innerHTML = '<div style="padding:12px;font-size:12px;color:#64748b">Nenhuma sugestão gerada.</div>';
      return;
    }

    const cores = { alta: '#fef2f2', media: '#fffbeb', baixa: '#f0fdf4' };
    const bordas = { alta: '#fca5a5', media: '#fcd34d', baixa: '#86efac' };
    const labels = { alta: '🔴 Alta', media: '🟡 Média', baixa: '🟢 Baixa' };

    results.innerHTML = `<div style="padding:8px 0 4px;font-size:11px;font-weight:700;color:#64748b">
      ✨ ${r.arquivos_analisados} arquivos analisados</div>` +
      r.sugestoes.map(s => `
        <div style="padding:9px 10px;border-radius:8px;margin-bottom:6px;
                    background:${cores[s.prioridade]||'#f8fafc'};
                    border:1px solid ${bordas[s.prioridade]||'#e2e8f0'}">
          <div style="font-size:11px;font-weight:700;color:#1e293b;margin-bottom:3px">
            ${s.titulo} <span style="font-weight:400;color:#64748b;float:right">${labels[s.prioridade]||''}</span>
          </div>
          <div style="font-size:11px;color:#475569">${s.descricao}</div>
        </div>`
      ).join('');
  } catch (e) {
    results.innerHTML = `<div style="padding:12px;font-size:12px;color:#ef4444">Erro: ${e.message}</div>`;
  }
}


// ══════════════════════════════════════════════════════════════════
//  INTEGRAÇÃO BANCO DO BRASIL
// ══════════════════════════════════════════════════════════════════
