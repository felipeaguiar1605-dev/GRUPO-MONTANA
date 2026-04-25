/**
 * Montana - Sistema de Permissoes
 * ---------------------------------
 * Define modulos do sistema, roles e suas permissoes.
 * Este arquivo eh a UNICA fonte de verdade para autorizacao.
 */

// ─── MODULOS DO SISTEMA ───────────────────────────────────────────
// Cada rota do /api/* mapeia pra um destes modulos
const MODULOS = {
  financeiro:   ['extratos', 'despesas', 'pagamentos', 'conta-vinculada', 'saldos', 'bb', 'ofx', 'conciliacao'],
  contratos:    ['contratos', 'licitacoes', 'parcelas', 'reajustes'],
  faturamento:  ['nfs', 'boletins', 'apuracao', 'webiss', 'vinculacoes', 'liquidacoes'],
  rh:           ['rh', 'volus'],
  ponto:        ['ponto'],
  juridico:     ['juridico'],
  certidoes:    ['certidoes'],
  compras:      ['compras'],
  estoque:      ['estoque', 'epi'],
  supervisao:   ['supervisao', 'postos'],
  relatorios:   ['relatorios', 'dre', 'calculadora', 'transparencia'],
  integracao:   ['alterdata', 'drive', 'ia', 'whatsapp', 'notificacoes'],
  sistema:      ['usuarios', 'auditoria', 'configuracoes', 'backups'],
};

// Mapa inverso: prefixo -> modulo
const PREFIXO_MODULO = {};
for (const [modulo, prefixos] of Object.entries(MODULOS)) {
  for (const p of prefixos) PREFIXO_MODULO[p] = modulo;
}

// ─── ROLES ────────────────────────────────────────────────────────
const ROLES = {
  admin: {
    descricao: 'Administrador total do sistema',
    empresas: '*',           // todas
    modulos:  '*',           // todos
    acoes:    ['read', 'write', 'delete', 'admin'],
  },

  diretoria: {
    descricao: 'Diretor - visao consolidada',
    empresas: '*',
    modulos:  '*',
    acoes:    ['read'],
    excecoes: {
      financeiro:  ['read', 'write'],
      contratos:   ['read', 'write'],
      faturamento: ['read', 'write'],
      relatorios:  ['read', 'write'],
    },
  },

  gerente: {
    descricao: 'Gerente de uma empresa especifica',
    empresas: 'lotacao',
    modulos:  '*',
    acoes:    ['read', 'write'],
    excecoes: {
      sistema: [],   // nao mexe em usuarios/sistema
    },
  },

  financeiro: {
    descricao: 'Equipe financeira',
    empresas: 'lotacao',
    modulos:  ['financeiro', 'faturamento', 'contratos', 'certidoes', 'relatorios'],
    acoes:    ['read', 'write'],
  },

  rh: {
    descricao: 'Recursos Humanos',
    empresas: 'lotacao',
    modulos:  ['rh', 'ponto', 'certidoes'],
    acoes:    ['read', 'write'],
  },

  juridico: {
    descricao: 'Equipe juridica',
    empresas: 'lotacao',
    modulos:  ['juridico', 'certidoes', 'contratos'],
    acoes:    ['read', 'write'],
    excecoes: {
      contratos: ['read'],   // so leitura em contratos
    },
  },

  operacional: {
    descricao: 'Operacao de campo / supervisao',
    empresas: 'lotacao',
    modulos:  ['supervisao', 'faturamento', 'compras', 'estoque', 'ponto'],
    acoes:    ['read', 'write'],
  },

  visualizador: {
    descricao: 'Somente leitura na empresa',
    empresas: 'lotacao',
    modulos:  '*',
    acoes:    ['read'],
  },

  auditor: {
    descricao: 'Auditor externo / Contador',
    empresas: '*',
    modulos:  '*',
    acoes:    ['read'],
  },
};

/** Resolve o modulo a partir do path (ex: /api/nfs/123 -> faturamento) */
function moduloDoPath(urlPath) {
  // remove prefixo /api/ e pega primeiro segmento
  const clean = urlPath.replace(/^\/api\//, '').split(/[\/?]/)[0];
  return PREFIXO_MODULO[clean] || null;
}

/** Converte metodo HTTP em acao (GET=read, POST/PATCH/PUT=write, DELETE=delete) */
function acaoDoMetodo(metodo) {
  const m = metodo.toUpperCase();
  if (m === 'GET')    return 'read';
  if (m === 'DELETE') return 'delete';
  return 'write';   // POST, PUT, PATCH
}

/** Verifica se role tem acesso a empresa solicitada */
function temAcessoEmpresa(role, empresaHeader, lotacaoUsuario) {
  const perfil = ROLES[role];
  if (!perfil) return false;
  if (perfil.empresas === '*') return true;
  // perfil.empresas === 'lotacao': compara com lotacao do usuario
  // lotacao pode ser CSV (ex: 'assessoria,seguranca')
  const permitidas = (lotacaoUsuario || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return permitidas.includes(empresaHeader.toLowerCase());
}

/** Verifica se role pode executar acao em modulo */
function temPermissao(role, modulo, acao) {
  const perfil = ROLES[role];
  if (!perfil) return false;

  // Modulo permitido?
  if (perfil.modulos !== '*' && !perfil.modulos.includes(modulo)) {
    return false;
  }

  // Acoes (considera excecoes)
  const acoesPermitidas = perfil.excecoes?.[modulo] || perfil.acoes;
  return acoesPermitidas.includes(acao);
}

module.exports = {
  MODULOS,
  ROLES,
  moduloDoPath,
  acaoDoMetodo,
  temAcessoEmpresa,
  temPermissao,
};
