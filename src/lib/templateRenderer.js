/**
 * Montana — Engine de templates para discriminação de NF
 *
 * Substitui placeholders {VAR} por valores reais.
 * Suporta: {COMPETENCIA}, {MES_NOME}, {ANO}, {PERIODO_INICIO}, {PERIODO_FIM},
 *          {POSTO_NOME}, {POSTO_MUNICIPIO}, {POSTO_DESCRICAO},
 *          {CONTRATO_NUMERO}, {CONTRATO_NOME}, {CONTRATANTE},
 *          {PROCESSO}, {PREGAO}, {VALOR_TOTAL}, {VALOR_TOTAL_BR}
 *
 * Uso:
 *   const ctx = buildContext({ contrato, posto, competencia, valor_total });
 *   const texto = render(template, ctx);
 */
'use strict';

const MESES_NOME = [
  'JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO',
  'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO',
];

/**
 * Calcula período do mês (último dia varia 28-31).
 * @param {string} comp 'YYYY-MM'
 * @returns {{inicio: 'YYYY-MM-DD', fim: 'YYYY-MM-DD', ultimoDia: number}}
 */
function periodoDoMes(comp) {
  const [ano, mes] = comp.split('-').map(Number);
  const ultimoDia = new Date(ano, mes, 0).getDate();
  return {
    inicio: `${comp}-01`,
    fim: `${comp}-${String(ultimoDia).padStart(2, '0')}`,
    ultimoDia,
  };
}

/**
 * Formata valor R$ com 2 casas e separador BR (vírgula decimal, ponto milhar).
 * 1234567.89 → '1.234.567,89'
 */
function formatBR(valor) {
  if (valor === null || valor === undefined) return '0,00';
  const n = Number(valor);
  if (!isFinite(n)) return '0,00';
  return n.toFixed(2)
    .replace('.', ',')
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * Monta o contexto de variáveis para renderização.
 * @param {object} args
 * @param {object} args.contrato — linha de bol_contratos
 * @param {object} [args.posto] — linha de bol_postos (opcional, pra contratos multi-posto)
 * @param {string} args.competencia — 'YYYY-MM'
 * @param {number} args.valor_total — valor calculado
 * @returns {object} mapa { CHAVE: valor }
 */
function buildContext({ contrato, posto, competencia, valor_total }) {
  const [ano, mes] = competencia.split('-').map(Number);
  const { inicio, fim } = periodoDoMes(competencia);
  const mesNome = MESES_NOME[mes - 1] || '';

  return {
    COMPETENCIA:       competencia,
    MES_NOME:          mesNome,
    ANO:               String(ano),
    PERIODO_INICIO:    inicio,                              // ISO
    PERIODO_FIM:       fim,                                  // ISO
    PERIODO_INICIO_BR: inicio.split('-').reverse().join('/'),// DD/MM/YYYY
    PERIODO_FIM_BR:    fim.split('-').reverse().join('/'),
    POSTO_NOME:        posto?.campus_nome || '',
    POSTO_MUNICIPIO:   posto?.municipio || '',
    POSTO_DESCRICAO:   posto?.descricao_posto || '',
    POSTO_KEY:         posto?.campus_key || '',
    CONTRATO_NUMERO:   contrato?.numero_contrato || '',
    CONTRATO_NOME:     contrato?.nome || '',
    CONTRATANTE:       contrato?.contratante || '',
    PROCESSO:          contrato?.processo || '',
    PREGAO:            contrato?.pregao || '',
    VALOR_TOTAL:       Number(valor_total || 0).toFixed(2),
    VALOR_TOTAL_BR:    formatBR(valor_total),
    EMPRESA_RAZAO:     contrato?.empresa_razao || '',
    EMPRESA_CNPJ:      contrato?.empresa_cnpj || '',
  };
}

/**
 * Renderiza template substituindo {VAR} por contexto[VAR].
 * Variáveis não encontradas viram string vazia (com warning).
 * Suporta {VAR|fallback} → usa fallback se VAR vazia.
 *
 * @param {string} template
 * @param {object} ctx
 * @returns {string}
 */
function render(template, ctx) {
  if (!template) return '';
  return String(template).replace(/\{(\w+)(?:\|([^}]*))?\}/g, (_, key, fallback) => {
    const v = ctx[key];
    if (v !== undefined && v !== null && v !== '') return String(v);
    return fallback !== undefined ? fallback : '';
  });
}

/**
 * Valida que o template tem placeholders esperados (warning se faltar).
 * Retorna lista de variáveis usadas e variáveis desconhecidas.
 */
function inspect(template) {
  if (!template) return { vars: [], desconhecidas: [] };
  const matches = [...template.matchAll(/\{(\w+)(?:\|[^}]*)?\}/g)];
  const vars = [...new Set(matches.map(m => m[1]))];
  const conhecidas = new Set([
    'COMPETENCIA', 'MES_NOME', 'ANO', 'PERIODO_INICIO', 'PERIODO_FIM',
    'PERIODO_INICIO_BR', 'PERIODO_FIM_BR',
    'POSTO_NOME', 'POSTO_MUNICIPIO', 'POSTO_DESCRICAO', 'POSTO_KEY',
    'CONTRATO_NUMERO', 'CONTRATO_NOME', 'CONTRATANTE', 'PROCESSO', 'PREGAO',
    'VALOR_TOTAL', 'VALOR_TOTAL_BR', 'EMPRESA_RAZAO', 'EMPRESA_CNPJ',
  ]);
  const desconhecidas = vars.filter(v => !conhecidas.has(v));
  return { vars, desconhecidas };
}

/**
 * Templates default por tipo de contrato (pra usar quando bol_contratos.template_discriminacao
 * está vazio). Heurística baseada no contratante.
 */
const TEMPLATES_DEFAULT = {
  detran: `PRESTAÇÃO DE SERVIÇOS DE LIMPEZA, ASSEIO E CONSERVAÇÃO, CONFORME CONTRATO N° {CONTRATO_NUMERO}, NAS INSTALAÇÕES DO DEPARTAMENTO ESTADUAL DE TRÂNSITO DO ESTADO DO TOCANTINS, NA CIDADE DE {POSTO_MUNICIPIO}. REFERENTE AO MÊS DE {MES_NOME} DE {ANO}.

BANCO DO BRASIL
AGÊNCIA N° 1505-9
CONTA CORRENTE N° 109043-7.`,

  uft: `PRESTAÇÃO DE SERVIÇOS DE {POSTO_DESCRICAO|VIGILÂNCIA}, CONFORME CONTRATO N° {CONTRATO_NUMERO}, PROCESSO {PROCESSO}, PREGÃO ELETRÔNICO {PREGAO}, NAS DEPENDÊNCIAS DO {POSTO_NOME}. REFERENTE AO PERÍODO DE {PERIODO_INICIO_BR} A {PERIODO_FIM_BR}.

BANCO DO BRASIL
AGÊNCIA N° 1505-9
CONTA CORRENTE N° 109043-7.`,

  generico: `PRESTAÇÃO DE SERVIÇOS CONFORME CONTRATO N° {CONTRATO_NUMERO}, REFERENTE AO MÊS DE {MES_NOME} DE {ANO}, NAS INSTALAÇÕES DA {CONTRATANTE}.

BANCO DO BRASIL
AGÊNCIA N° 1505-9
CONTA CORRENTE N° 109043-7.`,
};

/**
 * Sugere um template default baseado no contratante.
 */
function sugerirTemplateDefault(contrato) {
  const nome = (contrato?.contratante || contrato?.nome || '').toLowerCase();
  if (nome.includes('detran')) return TEMPLATES_DEFAULT.detran;
  if (nome.includes('universidade')) return TEMPLATES_DEFAULT.uft;
  return TEMPLATES_DEFAULT.generico;
}

module.exports = {
  buildContext,
  render,
  inspect,
  periodoDoMes,
  formatBR,
  sugerirTemplateDefault,
  MESES_NOME,
  TEMPLATES_DEFAULT,
};
