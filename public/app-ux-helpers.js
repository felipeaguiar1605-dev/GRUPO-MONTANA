/**
 * Montana — UX helpers compartilhados
 * Endereça pendências P1/P2 da auditoria UX:
 *  - P1-3:  tooltips de ajuda (info icons)
 *  - P1-7:  histórico persistente de toasts
 *  - P1-10: modal de confirm/alert custom (substitui nativos)
 *  - P2-11: atalhos de teclado globais
 *  - P2-15: URL state (hash) pra deep-link
 *
 * Carregado em todas as páginas via index.html.
 */
'use strict';

// ═════════════════════════════════════════════════════════════════
//   P1-3: TOOLTIPS — glossário inline pra termos do negócio
// ═════════════════════════════════════════════════════════════════
const UX_GLOSSARIO = {
  apostilamento: 'Aditivo unilateral pela administração pública para ajustes formais (ex: mudança de endereço, dotação orçamentária). NÃO altera valor.',
  reequilibrio:  'Restabelecimento da equação econômico-financeira do contrato. Usado quando há fato extraordinário que afeta o custo (ex: tributo novo, alta de combustível). PODE alterar valor.',
  reajuste:      'Atualização periódica de valores conforme índice contratado (CCT, IPCA, etc.). Aplicado mensalmente após data-base. Geralmente multiplicativo.',
  prorrogacao:   'Estende vigência do contrato sem alterar valores. Comum em contratos de prestação continuada após 12 meses.',
  previa:        'Boletim em rascunho — calculado pelo sistema mas ainda não aprovado pelo financeiro. Pode ser editado, regerado ou cancelado.',
  aprovado_para_emissao: 'Boletim revisado e aprovado pelo financeiro. Travado pra alteração. Próximo passo: emitir NF.',
  emitindo:      'Sistema está emitindo NFs no WebISS Palmas (uma a cada ~30s). Acompanhe o progresso em tempo real.',
  emitido:       'Todas as NFs do boletim foram emitidas com sucesso. Tem nfse_numero válido.',
  erro_emissao:  'Pelo menos uma NF do boletim falhou. Use "Reemitir falhas" para tentar novamente as NFs com erro (não re-emite as que já deram OK).',
  cancelado:     'Boletim cancelado antes da emissão. Auditoria fiscal exige motivo registrado.',
  conciliacao_3v: 'Cruzamento triplo: NF emitida × Extrato bancário × Comprovante de pagamento. Identifica recebimentos confirmados.',
  conciliacao_ia: 'Conciliação automática por aproximação (valor + data + tomador). Detecta casos onde 3 vias não bate exato.',
  pagador_alias: 'Apelidos para tomadores. Ex: o tomador "MUNICIPIO PALMAS" pode ter dezenas de unidades administrativas (UA) com CNPJs diferentes — aqui você unifica todas sob o mesmo contrato.',
  conta_vinculada: 'Conta bancária dedicada exclusivamente para um contrato (exigência da Lei 14.133/2021 — Nova Lei de Licitações). Movimentação separada do caixa principal.',
  base_legal: 'Documento jurídico que fundamenta o aditivo: número de CCT, ofício de reajuste, parecer técnico, etc.',
  template_discriminacao: 'Texto-modelo da NF, com placeholders {COMPETENCIA}, {POSTO_NOME}, {VALOR_TOTAL_BR} etc. — preenchido automaticamente na geração da prévia.',
  rps: 'Recibo Provisório de Serviço — número sequencial interno do prestador, atribuído antes da NFS-e oficial. Garante idempotência se WebISS der timeout.',
};

// Cria ícone de tooltip ao lado de um label/heading.
// Uso: <span data-uxhelp="apostilamento"></span> em qualquer HTML.
// Run uma vez no DOMContentLoaded (e quando html é injetado dinamicamente).
function uxRenderTooltips(scope) {
  const root = scope || document;
  for (const el of root.querySelectorAll('[data-uxhelp]:not([data-uxhelp-rendered])')) {
    const key = el.getAttribute('data-uxhelp').toLowerCase();
    const txt = UX_GLOSSARIO[key] || `Sem definição para: ${key}`;
    el.setAttribute('data-uxhelp-rendered', '1');
    el.innerHTML = `<span title="${txt.replace(/"/g, '&quot;')}" style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:#dbeafe;color:#1d4ed8;font-size:9px;font-weight:800;cursor:help;margin-left:4px;vertical-align:middle">i</span>`;
  }
}

// Ajuda usuário a obter texto via prompt: uxGlossario('reequilibrio') → string
window.uxGlossario = key => UX_GLOSSARIO[String(key || '').toLowerCase()] || '';
window.UX_GLOSSARIO = UX_GLOSSARIO;
window.uxRenderTooltips = uxRenderTooltips;

// ═════════════════════════════════════════════════════════════════
//   P1-7: HISTÓRICO PERSISTENTE DE TOASTS
// ═════════════════════════════════════════════════════════════════
const _toastHistorico = [];
const TOAST_HIST_MAX = 50;

// Wrap o toast() existente pra registrar histórico
(function() {
  const origToast = window.toast;
  if (typeof origToast !== 'function') return;
  window.toast = function(msg, tipo) {
    _toastHistorico.unshift({
      ts: new Date(),
      msg: String(msg || ''),
      tipo: tipo || 'info',
    });
    if (_toastHistorico.length > TOAST_HIST_MAX) _toastHistorico.length = TOAST_HIST_MAX;
    _atualizaToastHistBadge();
    return origToast.call(this, msg, tipo);
  };
})();

function _atualizaToastHistBadge() {
  const badge = document.getElementById('ux-toast-hist-badge');
  if (badge) badge.textContent = _toastHistorico.length;
}

function uxAbrirHistoricoToasts() {
  document.getElementById('modal-toast-hist')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'modal-toast-hist';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:flex-start;justify-content:flex-end;padding:60px 12px';
  const corMap = { info: '#3b82f6', success: '#16a34a', error: '#dc2626', warning: '#d97706' };
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:14px;width:min(420px, 92vw);max-height:85vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.35)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <h3 style="margin:0;font-size:13px;font-weight:800">📜 Histórico de notificações (${_toastHistorico.length})</h3>
        <div>
          <button class="btn btn-xs" onclick="uxLimparHistoricoToasts()">Limpar</button>
          <button class="btn btn-xs" onclick="document.getElementById('modal-toast-hist').remove()">✕</button>
        </div>
      </div>
      ${_toastHistorico.length === 0 ? `
        <div style="text-align:center;color:#94a3b8;padding:30px 10px;font-size:11px">Sem notificações.</div>
      ` : _toastHistorico.map(t => `
        <div style="border-left:3px solid ${corMap[t.tipo] || '#94a3b8'};padding:6px 8px;margin-bottom:4px;background:#f8fafc;border-radius:0 4px 4px 0;font-size:11px">
          <div style="color:#94a3b8;font-size:9px;text-transform:uppercase">${t.ts.toLocaleTimeString('pt-BR')} · ${t.tipo}</div>
          <div style="color:#0f172a">${t.msg.replace(/</g, '&lt;')}</div>
        </div>
      `).join('')}
    </div>
  `;
  document.body.appendChild(overlay);
}
window.uxAbrirHistoricoToasts = uxAbrirHistoricoToasts;
function uxLimparHistoricoToasts() {
  _toastHistorico.length = 0;
  _atualizaToastHistBadge();
  uxAbrirHistoricoToasts();
}
window.uxLimparHistoricoToasts = uxLimparHistoricoToasts;

// ═════════════════════════════════════════════════════════════════
//   P1-10: CUSTOM CONFIRM/ALERT (substitui native)
// ═════════════════════════════════════════════════════════════════
window.uxConfirm = function(opts) {
  const o = typeof opts === 'string' ? { msg: opts } : (opts || {});
  return new Promise(resolve => {
    document.getElementById('modal-uxconfirm')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'modal-uxconfirm';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10001;display:flex;align-items:center;justify-content:center;padding:5vh 16px';
    const tipo = o.tipo || 'info';
    const cor = { info: '#3b82f6', warning: '#d97706', danger: '#dc2626' }[tipo] || '#3b82f6';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:18px 20px;width:min(440px, 92vw);box-shadow:0 20px 60px rgba(0,0,0,.35);border-top:4px solid ${cor}">
        ${o.titulo ? `<h3 style="margin:0 0 6px;font-size:14px;font-weight:800;color:${cor}">${o.titulo}</h3>` : ''}
        <div style="font-size:13px;color:#0f172a;line-height:1.5;white-space:pre-wrap">${(o.msg || '').replace(/</g, '&lt;')}</div>
        ${o.detalhe ? `<div style="font-size:11px;color:#64748b;margin-top:8px;padding:8px;background:#f8fafc;border-radius:6px">${o.detalhe.replace(/</g, '&lt;')}</div>` : ''}
        <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:14px">
          ${o.cancelLabel !== null ? `<button class="btn btn-sm" onclick="document.getElementById('modal-uxconfirm').remove();window._uxR(false)">${o.cancelLabel || 'Cancelar'}</button>` : ''}
          <button class="btn btn-sm btn-primary" style="background:${cor};border-color:${cor}" onclick="document.getElementById('modal-uxconfirm').remove();window._uxR(true)">${o.okLabel || 'Confirmar'}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    window._uxR = resolve;
  });
};

window.uxAlert = function(msg, opts) {
  return uxConfirm({ msg, cancelLabel: null, okLabel: 'OK', ...(opts || {}) });
};

// ═════════════════════════════════════════════════════════════════
//   P2-11: ATALHOS DE TECLADO GLOBAIS
// ═════════════════════════════════════════════════════════════════
const UX_SHORTCUTS = [
  { keys: 'Alt+B', desc: 'Ir para Boletins',         action: () => navGo?.('boletins') },
  { keys: 'Alt+C', desc: 'Ir para Contratos',        action: () => navGo?.('cont') },
  { keys: 'Alt+N', desc: 'Ir para Notas Fiscais',    action: () => navGo?.('nfs') },
  { keys: 'Alt+E', desc: 'Ir para Extratos',         action: () => navGo?.('ext') },
  { keys: 'Alt+D', desc: 'Ir para Dashboard',        action: () => navGo?.('dash') },
  { keys: 'Alt+P', desc: 'Abrir Prévias / Emissão',  action: () => abrirPrevias?.() },
  { keys: 'Alt+A', desc: 'Abrir Aditivos',           action: () => abrirAditivos?.() },
  { keys: 'Ctrl+/', desc: 'Foco busca global',       action: () => document.getElementById('busca-global-input')?.focus() },
  { keys: 'Shift+?', desc: 'Mostrar este help',      action: () => uxMostrarShortcuts() },
  { keys: 'Esc',   desc: 'Fechar modal aberto',      action: () => {
    const modais = document.querySelectorAll('[id^="modal-"]');
    if (modais.length) modais[modais.length - 1].remove();
  } },
];

document.addEventListener('keydown', e => {
  // Ignora se está digitando em input/textarea/select
  const tag = (e.target.tagName || '').toLowerCase();
  const isEditable = ['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable;

  // Esc sempre funciona
  if (e.key === 'Escape') {
    UX_SHORTCUTS.find(s => s.keys === 'Esc')?.action();
    return;
  }
  if (isEditable) return;

  for (const s of UX_SHORTCUTS) {
    const parts = s.keys.split('+');
    const k = parts[parts.length - 1].toLowerCase();
    const altOk = parts.includes('Alt') ? e.altKey : !e.altKey;
    const ctrlOk = parts.includes('Ctrl') ? (e.ctrlKey || e.metaKey) : !(e.ctrlKey || e.metaKey);
    const shiftOk = parts.includes('Shift') ? e.shiftKey : !e.shiftKey;
    if (e.key.toLowerCase() === k && altOk && ctrlOk && shiftOk) {
      e.preventDefault();
      s.action();
      return;
    }
  }
});

function uxMostrarShortcuts() {
  document.getElementById('modal-shortcuts')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'modal-shortcuts';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center;padding:5vh 20px';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;width:min(480px, 92vw);box-shadow:0 20px 60px rgba(0,0,0,.35)">
      <h3 style="margin:0 0 12px;font-size:14px;font-weight:800">⌨️ Atalhos de teclado</h3>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:12px">
        ${UX_SHORTCUTS.map(s => `
          <kbd style="background:#1e293b;color:#fff;padding:3px 8px;border-radius:4px;font-family:monospace;font-size:10px;font-weight:700">${s.keys}</kbd>
          <span style="color:#475569">${s.desc}</span>
        `).join('')}
      </div>
      <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:14px">
        <button class="btn btn-sm btn-primary" onclick="document.getElementById('modal-shortcuts').remove()">Fechar</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}
window.uxMostrarShortcuts = uxMostrarShortcuts;

// ═════════════════════════════════════════════════════════════════
//   P1-9 / P2-15: PERSISTÊNCIA DE FILTROS + URL STATE
// ═════════════════════════════════════════════════════════════════
window.uxSaveFiltro = function(key, val) {
  try {
    sessionStorage.setItem('mtn_filtro_' + key, JSON.stringify(val));
  } catch (_) {}
};
window.uxLoadFiltro = function(key, fallback) {
  try {
    const v = sessionStorage.getItem('mtn_filtro_' + key);
    return v ? JSON.parse(v) : (fallback ?? null);
  } catch (_) { return fallback ?? null; }
};
window.uxClearFiltro = function(key) {
  try { sessionStorage.removeItem('mtn_filtro_' + key); } catch (_) {}
};

// ═════════════════════════════════════════════════════════════════
//   Registra renderização de tooltips e badge de hist após DOM ready
// ═════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  uxRenderTooltips();
  // Observa mudanças no DOM pra renderizar tooltips em conteúdo dinâmico
  const observer = new MutationObserver(muts => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1 && n.querySelector?.('[data-uxhelp]:not([data-uxhelp-rendered])')) {
          uxRenderTooltips(n);
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
});
