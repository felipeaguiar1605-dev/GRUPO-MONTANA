/**
 * Montana Multi-Empresa — Catálogo de Empresas
 * Fonte única de verdade para identidade, cores, CNPJs e padrões de segurança.
 *
 * Certificados A1 (PKCS#12): certificados/
 */
const path = require('path');
const CERT_DIR = path.join(__dirname, '..', 'certificados');
module.exports = {
  assessoria: {
    key: 'assessoria',
    nome: 'Montana Assessoria Empresarial LTDA',
    nomeAbrev: 'Montana Assessoria',
    cnpj: '14.092.519/0001-51',
    cnpjRaw: '14092519000151',
    cor: '#0d6efd',
    corFundo: '#cfe2ff',
    corTexto: '#ffffff',
    icone: '🏢',
    dbPath: 'data/assessoria/montana.db',
    uploadsPath: 'data/assessoria/uploads',
    // Padrões que identificam este empresa (para auto-detectar em uploads)
    certificadoPfx: path.join(CERT_DIR, 'assessoria.pfx'),
    padroesPropriosNome: [/assessoria/i, /14\.092\.519/i, /14092519/i],
    // Padrões da empresa ERRADA (bloqueiam importação cruzada)
    padroesBloqueados: [
      /montana\s*seguran[çc]a/i,
      /mont.*seg.*concilia/i,
      /seg_conciliacao/i,
      /22\.516\.770/,
      /22516770/,
    ]
  },
  portodovau: {
    key: 'portodovau',
    nome: 'Porto do Vau Segurança Privada LTDA',
    nomeAbrev: 'Porto do Vau',
    cnpj: '41.034.574/0001-68',
    cnpjRaw: '41034574000168',
    cor: '#6f42c1',
    corFundo: '#e2d9f3',
    corTexto: '#ffffff',
    icone: '🛡️',
    dbPath: 'data/portodovau/montana.db',
    uploadsPath: 'data/portodovau/uploads',
    certificadoPfx: path.join(CERT_DIR, 'portodovau.pfx'),
    padroesPropriosNome: [/porto\s*do\s*vau/i, /portodovau/i, /41\.034\.574/i, /41034574/i],
    padroesBloqueados: [
      /assessoria\s*empresarial/i, /montana.*assessoria/i, /14\.092\.519/, /14092519/,
      /montana\s*seguran/i, /19\.200\.109/, /19200109/,
      /mustang/i, /26\.600\.137/, /26600137/,
    ]
  },
  mustang: {
    key: 'mustang',
    nome: 'Mustang Gestão Empresarial LTDA',
    nomeAbrev: 'Mustang',
    cnpj: '26.600.137/0001-70',
    cnpjRaw: '26600137000170',
    cor: '#fd7e14',
    corFundo: '#ffe5d0',
    corTexto: '#ffffff',
    icone: '🐎',
    dbPath: 'data/mustang/montana.db',
    uploadsPath: 'data/mustang/uploads',
    certificadoPfx: path.join(CERT_DIR, 'mustang.pfx'),
    padroesPropriosNome: [/mustang/i, /26\.600\.137/i, /26600137/i],
    padroesBloqueados: [
      /assessoria\s*empresarial/i, /montana.*assessoria/i, /14\.092\.519/, /14092519/,
      /montana\s*seguran/i, /19\.200\.109/, /19200109/,
      /porto\s*do\s*vau/i, /41\.034\.574/, /41034574/,
    ]
  },
  seguranca: {
    key: 'seguranca',
    nome: 'Montana Segurança Privada LTDA',
    nomeAbrev: 'Montana Segurança',
    cnpj: '19.200.109/0001-09',
    cnpjRaw: '19200109000109',
    cor: '#dc3545',
    corFundo: '#f8d7da',
    corTexto: '#ffffff',
    icone: '🔒',
    dbPath: 'data/seguranca/montana.db',
    uploadsPath: 'data/seguranca/uploads',
    certificadoPfx: path.join(CERT_DIR, 'seguranca.pfx'),
    // Padrões que identificam esta empresa (aceita nome antigo EPP também)
    padroesPropriosNome: [
      /seguran[çc]a/i,
      /19\.200\.109/i,
      /19200109/i,
      /22\.516\.770/i,
      /22516770/i,
    ],
    // Padrões da empresa ERRADA (bloqueiam importação cruzada)
    padroesBloqueados: [
      /assessoria\s*empresarial/i,
      /montana.*assessoria/i,
      /assessoria_conciliacao/i,
      /14\.092\.519/,
      /14092519/,
    ]
  }
};
