/**
 * Setup Certidões + Boletins Assessoria
 * — Importa 6 CNDs ativas (datas extraídas dos PDFs)
 * — Adiciona 4 contratos ao módulo Boletins: SESAU, UFNT, UFT Motorista, UNITINS
 * — Adiciona postos desativados como contratos históricos (ativo=0)
 * Uso: node scripts/setup_certidoes_boletins_assessoria.js [--dry-run]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const db = getDb('assessoria');

  // ══════════════════════════════════════════════════════════════
  // 1. CERTIDÕES NEGATIVAS — Assessoria
  // ══════════════════════════════════════════════════════════════
  console.log('\n📋 CERTIDÕES NEGATIVAS — Montana Assessoria');
  console.log('═'.repeat(50));

  const cnds = [
    {
      tipo: 'Certidão Negativa Estadual (SEFAZ/TO)',
      data_validade: '2026-04-24',
      arquivo_pdf: 'CND ESTADUAL VENCE 24-04-2026.pdf',
      observacoes: 'Dívida Ativa do Estado do Tocantins',
      status: 'válida',
    },
    {
      tipo: 'Certidão Negativa de Falência e Concordata',
      data_validade: '2026-05-02',
      arquivo_pdf: 'CND FALÊNCIA VENCE 02-05-2026.pdf',
      observacoes: 'Certidão Judicial — Falência e Concordata',
      status: 'válida',
    },
    {
      tipo: 'Certidão Negativa Federal (RFB/PGFN)',
      data_validade: '2026-05-04',
      arquivo_pdf: 'CND FEDERAL VENCE 04-05-2026.pdf',
      observacoes: 'Débitos relativos a Tributos Federais e Dívida Ativa da União',
      status: 'válida',
    },
    {
      tipo: 'Certidão de Regularidade do FGTS (CRF)',
      data_validade: '2026-04-25',
      arquivo_pdf: 'CND FGTS VENCE 25-04-2026.pdf',
      observacoes: 'Certificado de Regularidade do FGTS — Caixa Econômica Federal',
      status: 'válida',
    },
    {
      tipo: 'Certidão Negativa Municipal (Prefeitura Palmas)',
      data_validade: '2026-04-25',
      arquivo_pdf: 'CND MUNICIPAL VENCE 25-04-2026.pdf',
      observacoes: 'Certidão Negativa de Débitos Municipais — Palmas/TO',
      status: 'válida',
    },
    {
      tipo: 'Certidão Negativa Trabalhista (TST)',
      data_validade: '2026-08-23',
      arquivo_pdf: 'CND TRABALHISTA VENCE 23-08-2026.pdf',
      observacoes: 'Certidão Negativa de Débitos Trabalhistas — TST',
      status: 'válida',
    },
  ];

  const insCertidao = db.prepare(`
    INSERT OR IGNORE INTO certidoes
      (tipo, numero, data_emissao, data_validade, arquivo_pdf, status, observacoes)
    VALUES (?, '', '', ?, ?, ?, ?)
  `);

  // Verifica se já existem
  const existCert = db.prepare("SELECT COUNT(*) n FROM certidoes WHERE tipo = ?");

  let certOk = 0, certSkip = 0;
  for (const cnd of cnds) {
    const already = existCert.get(cnd.tipo);
    if (already.n > 0) {
      console.log(`  ⏭️  Já existe: ${cnd.tipo}`);
      certSkip++;
      continue;
    }
    if (!DRY_RUN) {
      insCertidao.run(cnd.tipo, cnd.data_validade, cnd.arquivo_pdf, cnd.status, cnd.observacoes);
    }
    console.log(`  ✅ ${cnd.tipo} — vence ${cnd.data_validade}`);
    certOk++;
  }
  console.log(`\n  Inseridas: ${certOk} | Já existiam: ${certSkip}`);

  // ══════════════════════════════════════════════════════════════
  // 2. BOL_CONTRATOS — 4 novos contratos
  // ══════════════════════════════════════════════════════════════
  console.log('\n\n📂 BOLETINS DE MEDIÇÃO — Novos Contratos');
  console.log('═'.repeat(50));

  const insContrato = db.prepare(`
    INSERT OR IGNORE INTO bol_contratos
      (nome, contratante, numero_contrato, processo, pregao,
       descricao_servico, escala, empresa_razao, empresa_cnpj, ativo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getContrato = db.prepare("SELECT id FROM bol_contratos WHERE numero_contrato = ? LIMIT 1");

  const novosContratos = [
    {
      nome: 'SESAU — Limpeza, Copeiragem e Recepção',
      contratante: 'SECRETARIA DE ESTADO DA SAÚDE DO TOCANTINS — SESAU',
      numero_contrato: '78/2022',
      processo: '',
      pregao: '',
      descricao_servico: 'Prestação de Serviços Continuados de Limpeza, Asseio, Conservação, Copeiragem e Recepção nas unidades da SESAU em Palmas e Araguaína',
      escala: '5x2',
      ativo: 1,
      postos: [
        { key: 'PALMAS_ANEXO_I',     nome: 'Palmas — Anexo I',           municipio: 'Palmas/TO',    desc: 'SESAU — Anexo I (Limpeza, Copeiragem, Recepção)',     ordem: 1 },
        { key: 'PALMAS_SVO',         nome: 'Palmas — SVO',               municipio: 'Palmas/TO',    desc: 'SESAU — SVO (Serviço de Verificação de Óbito)',       ordem: 2 },
        { key: 'LACEN_PALMAS',       nome: 'LACEN Palmas',               municipio: 'Palmas/TO',    desc: 'SESAU — LACEN Palmas (Laboratório Central)',          ordem: 3 },
        { key: 'IMUNIZACAO_PALMAS',  nome: 'Imunização Palmas',          municipio: 'Palmas/TO',    desc: 'SESAU — Centro de Imunização Palmas',                 ordem: 4 },
        { key: 'IMUNIZACAO_ARAGUAINA', nome: 'Imunização Araguaína',     municipio: 'Araguaína/TO', desc: 'SESAU — Centro de Imunização Araguaína',              ordem: 5 },
        { key: 'LACEN_ARAGUAINA',    nome: 'LACEN Araguaína',            municipio: 'Araguaína/TO', desc: 'SESAU — LACEN Araguaína (Laboratório)',               ordem: 6 },
        { key: 'PALMAS_ANEXO_IV',    nome: 'Palmas — Anexo IV',          municipio: 'Palmas/TO',    desc: 'SESAU — Anexo IV',                                   ordem: 7 },
      ],
      itens_por_posto: {
        PALMAS_ANEXO_I:      [
          { desc: 'Auxiliar de Serviços Gerais (Limpeza)', qtd: 5, valor: 5973.30 },
          { desc: 'Copeiro(a)',                             qtd: 1, valor: 4742.90 },
          { desc: 'Recepcionista',                          qtd: 1, valor: 8527.65 },
        ],
        PALMAS_SVO:          [
          { desc: 'Auxiliar de Serviços Gerais (Limpeza)', qtd: 3, valor: 5973.30 },
          { desc: 'Copeiro(a)',                             qtd: 1, valor: 4742.90 },
        ],
        LACEN_PALMAS:        [
          { desc: 'Auxiliar de Serviços Gerais (Limpeza)', qtd: 14, valor: 5973.30 },
          { desc: 'Copeiro(a)',                              qtd: 1,  valor: 4742.90 },
          { desc: 'Encarregado(a)',                          qtd: 1,  valor: 7821.44 },
        ],
        IMUNIZACAO_PALMAS:   [{ desc: 'Auxiliar de Serviços Gerais (Limpeza)', qtd: 2, valor: 8577.98 }],
        IMUNIZACAO_ARAGUAINA:[{ desc: 'Auxiliar de Serviços Gerais (Limpeza)', qtd: 2, valor: 8577.98 }],
        LACEN_ARAGUAINA:     [{ desc: 'Auxiliar de Serviços Gerais (Limpeza)', qtd: 3, valor: 7613.94 }],
        PALMAS_ANEXO_IV:     [{ desc: 'Auxiliar de Serviços Gerais (Limpeza)', qtd: 1, valor: 6557.05 }],
      },
    },
    {
      nome: 'UFNT — Limpeza e ATOP',
      contratante: 'UNIVERSIDADE FEDERAL DO NORTE DO TOCANTINS — UFNT',
      numero_contrato: '30/2022',
      processo: '',
      pregao: '',
      descricao_servico: 'Prestação de Serviços Continuados de Limpeza, Asseio e Conservação e Apoio Técnico Operacional (ATOP) nas unidades da UFNT',
      escala: '5x2',
      ativo: 1,
      postos: [
        { key: 'CCS',            nome: 'CCS — Araguaína',     municipio: 'Araguaína/TO',    desc: 'UFNT — CCS (Centro de Ciências da Saúde)',              ordem: 1 },
        { key: 'CIMBA',          nome: 'CIMBA — Araguaína',   municipio: 'Araguaína/TO',    desc: 'UFNT — CIMBA (Centro Interdisciplinar de Araguaína)',   ordem: 2 },
        { key: 'CCA',            nome: 'CCA — Araguaína',     municipio: 'Araguaína/TO',    desc: 'UFNT — CCA (Centro de Ciências Agrárias)',              ordem: 3 },
        { key: 'TOCANTINOPOLIS', nome: 'Tocantinópolis',      municipio: 'Tocantinópolis/TO', desc: 'UFNT — Campus Tocantinópolis',                        ordem: 4 },
      ],
      itens_por_posto: {
        CCS:            [
          { desc: 'Limpeza com fornecimento de material',    qtd: 1, valor: 4730.37 },
          { desc: 'ATOP com fornecimento de material',       qtd: 1, valor: 19732.29 },
          { desc: 'ATOP sem fornecimento de material',       qtd: 1, valor: 4317.09 },
        ],
        CIMBA:          [
          { desc: 'Limpeza com fornecimento de material',    qtd: 1, valor: 12466.18 },
          { desc: 'ATOP com fornecimento de material',       qtd: 1, valor: 65450.56 },
          { desc: 'ATOP sem fornecimento de material',       qtd: 1, valor: 32555.23 },
        ],
        CCA:            [
          { desc: 'Limpeza com fornecimento de material',    qtd: 1, valor: 36621.49 },
          { desc: 'ATOP com fornecimento de material',       qtd: 1, valor: 73607.20 },
          { desc: 'ATOP sem fornecimento de material',       qtd: 1, valor: 40868.76 },
        ],
        TOCANTINOPOLIS: [
          { desc: 'Limpeza com fornecimento de material',    qtd: 1, valor: 8987.21 },
          { desc: 'ATOP com fornecimento de material',       qtd: 1, valor: 44066.19 },
          { desc: 'ATOP sem fornecimento de material',       qtd: 1, valor: 3799.36 },
        ],
      },
    },
    {
      nome: 'UFT — Motoristas e Tratoristas',
      contratante: 'FUNDAÇÃO UNIVERSIDADE FEDERAL DO TOCANTINS — UFT',
      numero_contrato: '05/2025',
      processo: '',
      pregao: '',
      descricao_servico: 'Prestação de Serviços Continuados de Motoristas, Tratoristas, Motociclistas e Encarregados nas unidades da UFT',
      escala: '5x2',
      ativo: 1,
      postos: [
        { key: 'ARRAIAS',        nome: 'Arraias',         municipio: 'Arraias/TO',         desc: 'UFT — Campus Arraias (Motoristas)',           ordem: 1 },
        { key: 'GURUPI',         nome: 'Gurupi',          municipio: 'Gurupi/TO',          desc: 'UFT — Campus Gurupi (Motoristas/Tratoristas)', ordem: 2 },
        { key: 'MIRACEMA',       nome: 'Miracema',        municipio: 'Miracema do TO/TO',  desc: 'UFT — Campus Miracema (Motoristas)',           ordem: 3 },
        { key: 'PALMAS',         nome: 'Palmas',          municipio: 'Palmas/TO',          desc: 'UFT — Campus Palmas (Motoristas)',             ordem: 4 },
        { key: 'PALMAS_REITORIA', nome: 'Palmas — Reitoria', municipio: 'Palmas/TO',      desc: 'UFT — Reitoria Palmas (Motoristas/Motociclista)', ordem: 5 },
        { key: 'PORTO_NACIONAL', nome: 'Porto Nacional',  municipio: 'Porto Nacional/TO',  desc: 'UFT — Campus Porto Nacional (Motoristas)',    ordem: 6 },
      ],
      itens_por_posto: {
        ARRAIAS:         [{ desc: 'Motorista',    qtd: 3, valor: 6732.55 }],
        GURUPI:          [
          { desc: 'Motorista',   qtd: 3, valor: 6685.03 },
          { desc: 'Tratorista',  qtd: 1, valor: 6332.15 },
        ],
        MIRACEMA:        [{ desc: 'Motorista',    qtd: 3, valor: 6649.72 }],
        PALMAS:          [
          { desc: 'Encarregado', qtd: 1, valor: 9915.81 },
          { desc: 'Motorista',   qtd: 5, valor: 6799.80 },
          { desc: 'Tratorista',  qtd: 1, valor: 6404.73 },
        ],
        PALMAS_REITORIA: [
          { desc: 'Encarregado',  qtd: 3, valor: 9915.81 },
          { desc: 'Motorista',    qtd: 6, valor: 6799.80 },
          { desc: 'Motociclista', qtd: 1, valor: 5518.20 },
        ],
        PORTO_NACIONAL:  [{ desc: 'Motorista', qtd: 4, valor: 6783.13 }],
      },
    },
    {
      nome: 'UNITINS — Limpeza, Copeiragem e Jardinagem',
      contratante: 'UNIVERSIDADE ESTADUAL DO TOCANTINS — UNITINS',
      numero_contrato: '022/2022',
      processo: '',
      pregao: '',
      descricao_servico: 'Prestação de Serviços Continuados de Limpeza, Asseio, Conservação, Copeiragem e Jardinagem nas unidades da UNITINS em todo o Tocantins',
      escala: '5x2',
      ativo: 1,
      postos: [
        { key: 'PALMAS_SEDE',      nome: 'Palmas — Sede',      municipio: 'Palmas/TO',         desc: 'UNITINS — Sede Palmas',                   ordem: 1 },
        { key: 'PALMAS_GRACIOSA',  nome: 'Palmas — Graciosa',  municipio: 'Palmas/TO',         desc: 'UNITINS — Polo Graciosa',                  ordem: 2 },
        { key: 'PALMAS_COMPLEXO',  nome: 'Palmas — Complexo',  municipio: 'Palmas/TO',         desc: 'UNITINS — Complexo Palmas',                ordem: 3 },
        { key: 'PALMAS_TAQUARUCU', nome: 'Palmas — Taquaruçu', municipio: 'Palmas/TO',         desc: 'UNITINS — Polo Taquaruçu',                ordem: 4 },
        { key: 'ARAGUATINS',       nome: 'Araguatins',         municipio: 'Araguatins/TO',     desc: 'UNITINS — Polo Araguatins',               ordem: 5 },
        { key: 'ARAGUAINA',        nome: 'Araguaína',          municipio: 'Araguaína/TO',      desc: 'UNITINS — Polo Araguaína',                ordem: 6 },
        { key: 'AUGUSTINOPOLIS',   nome: 'Augustinópolis',     municipio: 'Augustinópolis/TO', desc: 'UNITINS — Polo Augustinópolis',           ordem: 7 },
        { key: 'DIANOPOLIS',       nome: 'Dianópolis',         municipio: 'Dianópolis/TO',     desc: 'UNITINS — Polo Dianópolis',               ordem: 8 },
        { key: 'FORMOSO',          nome: 'Formoso do Araguaia', municipio: 'Formoso do Araguaia/TO', desc: 'UNITINS — Polo Formoso do Araguaia', ordem: 9 },
        { key: 'GURUPI',           nome: 'Gurupi',             municipio: 'Gurupi/TO',         desc: 'UNITINS — Polo Gurupi',                   ordem: 10 },
        { key: 'PARAISO',          nome: 'Paraíso do TO',      municipio: 'Paraíso do TO/TO',  desc: 'UNITINS — Polo Paraíso do Tocantins',    ordem: 11 },
        { key: 'PORTO_NACIONAL',   nome: 'Porto Nacional',     municipio: 'Porto Nacional/TO', desc: 'UNITINS — Polo Porto Nacional',           ordem: 12 },
      ],
      itens_por_posto: {
        PALMAS_SEDE:      [
          { desc: 'Auxiliar de Serviços Gerais (Limpeza)', qtd: 7,  valor: 5893.55 },
          { desc: 'Copeiro(a)',                             qtd: 1,  valor: 4742.90 },
          { desc: 'Jardineiro',                             qtd: 1,  valor: 7243.51 },
        ],
        PALMAS_GRACIOSA:  [
          { desc: 'Auxiliar de Serviços Gerais (Limpeza)', qtd: 9,  valor: 5893.55 },
          { desc: 'Copeiro(a)',                             qtd: 2,  valor: 4742.90 },
          { desc: 'Jardineiro',                             qtd: 1,  valor: 7243.51 },
        ],
        PALMAS_COMPLEXO:  [
          { desc: 'Auxiliar de Serviços Gerais (Limpeza)', qtd: 4,  valor: 5893.55 },
          { desc: 'Copeiro(a)',                             qtd: 1,  valor: 4742.90 },
        ],
        PALMAS_TAQUARUCU: [
          { desc: 'Auxiliar de Serviços Gerais (Limpeza)', qtd: 1,  valor: 5973.30 },
          { desc: 'Copeiro(a)',                             qtd: 1,  valor: 2035.70 },
        ],
        ARAGUATINS:       [{ desc: 'Auxiliar de Serviços Gerais (Limpeza)', qtd: 2, valor: 5973.30 }],
        ARAGUAINA:        [{ desc: 'Auxiliar de Serviços Gerais (Limpeza)', qtd: 2, valor: 5973.30 }],
        AUGUSTINOPOLIS:   [{ desc: 'Auxiliar de Serviços Gerais (Limpeza)', qtd: 2, valor: 5973.30 }],
        DIANOPOLIS:       [{ desc: 'Auxiliar de Serviços Gerais (Limpeza)', qtd: 2, valor: 5973.30 }],
        FORMOSO:          [{ desc: 'Auxiliar de Serviços Gerais (Limpeza)', qtd: 2, valor: 5973.30 }],
        GURUPI:           [{ desc: 'Auxiliar de Serviços Gerais (Limpeza)', qtd: 2, valor: 5973.30 }],
        PARAISO:          [{ desc: 'Auxiliar de Serviços Gerais (Limpeza)', qtd: 2, valor: 5973.30 }],
        PORTO_NACIONAL:   [{ desc: 'Auxiliar de Serviços Gerais (Limpeza)', qtd: 2, valor: 5973.30 }],
      },
    },
  ];

  // Postos desativados (histórico)
  const postosDesativados = [
    {
      nome: 'CBMTO — Corpo de Bombeiros (encerrado)',
      contratante: 'CORPO DE BOMBEIROS MILITAR DO ESTADO DO TOCANTINS — CBMTO',
      numero_contrato: '011/2023',
      descricao_servico: 'Prestação de Serviços de Limpeza e Conservação nas instalações do CBMTO — ENCERRADO',
      ativo: 0,
      postos: [
        { key: 'CBMTO_PALMAS', nome: 'CBMTO — Palmas', municipio: 'Palmas/TO', desc: 'CBMTO — Sede Palmas (encerrado)', ordem: 1 },
      ],
      itens_por_posto: {
        CBMTO_PALMAS: [{ desc: 'Auxiliar de Serviços Gerais (Limpeza)', qtd: 4, valor: 8988.30 }],
      },
    },
    {
      nome: 'SEPLAD — Planejamento (encerrado)',
      contratante: 'SECRETARIA DO PLANEJAMENTO E ADMINISTRAÇÃO — SEPLAD',
      numero_contrato: 'SEPLAD/2022',
      descricao_servico: 'Prestação de Serviços de Limpeza e Conservação na SEPLAD — ENCERRADO',
      ativo: 0,
      postos: [
        { key: 'SEPLAD_PALMAS', nome: 'SEPLAD — Palmas', municipio: 'Palmas/TO', desc: 'SEPLAD — Sede (encerrado)', ordem: 1 },
      ],
      itens_por_posto: {
        SEPLAD_PALMAS: [{ desc: 'Auxiliar de Serviços Gerais (Limpeza)', qtd: 2, valor: 5973.30 }],
      },
    },
    {
      nome: 'NABLA/Mustang — Segurança Privada (encerrado)',
      contratante: 'NABLA ADMINISTRADORA DE BENS LTDA',
      numero_contrato: 'NABLA/2022',
      descricao_servico: 'Prestação de Serviços de Segurança Privada — ENCERRADO',
      ativo: 0,
      postos: [
        { key: 'NABLA_PALMAS', nome: 'NABLA — Palmas', municipio: 'Palmas/TO', desc: 'NABLA/Mustang — Posto Palmas (encerrado)', ordem: 1 },
      ],
      itens_por_posto: {
        NABLA_PALMAS: [{ desc: 'Vigilante Patrimonial', qtd: 2, valor: 4500.00 }],
      },
    },
  ];

  const insPostoStmt = db.prepare(`
    INSERT OR IGNORE INTO bol_postos
      (contrato_id, campus_key, campus_nome, municipio, descricao_posto, ordem, label_resumo)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const getPostoStmt = db.prepare("SELECT id FROM bol_postos WHERE contrato_id = ? AND campus_key = ? LIMIT 1");
  const insItemStmt  = db.prepare(`
    INSERT OR IGNORE INTO bol_itens
      (posto_id, descricao, quantidade, valor_unitario, ordem)
    VALUES (?, ?, ?, ?, ?)
  `);

  function seedContrato(c) {
    if (!DRY_RUN) insContrato.run(
      c.nome, c.contratante, c.numero_contrato, c.processo || '', c.pregao || '',
      c.descricao_servico, c.escala || '5x2',
      'MONTANA ASSESSORIA EMPRESARIAL LTDA', '14.092.519/0001-51', c.ativo
    );
    const row = getContrato.get(c.numero_contrato);
    const cId = row ? row.id : 0;
    console.log(`  ${c.ativo ? '✅' : '🗂️ '} ${c.nome} (nº ${c.numero_contrato}) → id ${cId}`);

    let postoCount = 0, itemCount = 0;
    if (!DRY_RUN && cId) {
      for (const p of c.postos) {
        insPostoStmt.run(cId, p.key, p.nome, p.municipio, p.desc, p.ordem, p.nome);
        const pRow = getPostoStmt.get(cId, p.key);
        if (!pRow) { console.log(`    ⚠️  Posto não criado: ${p.key}`); continue; }
        const pId = pRow.id;
        postoCount++;
        const itens = (c.itens_por_posto || {})[p.key] || [];
        itens.forEach((it, idx) => {
          insItemStmt.run(pId, it.desc, it.qtd, it.valor, idx + 1);
          itemCount++;
        });
      }
    } else if (DRY_RUN) {
      postoCount = c.postos.length;
      for (const p of c.postos) {
        itemCount += ((c.itens_por_posto || {})[p.key] || []).length;
      }
    }
    console.log(`     └── ${postoCount} postos, ${itemCount} itens`);
  }

  console.log('\n  Contratos ativos:');
  for (const c of novosContratos) seedContrato(c);

  console.log('\n  Postos desativados (histórico):');
  for (const c of postosDesativados) seedContrato(c);

  // ══════════════════════════════════════════════════════════════
  // 3. RESUMO FINAL
  // ══════════════════════════════════════════════════════════════
  if (!DRY_RUN) {
    const totCert  = db.prepare('SELECT COUNT(*) n FROM certidoes').get().n;
    const totBolC  = db.prepare('SELECT COUNT(*) n FROM bol_contratos').get().n;
    const totBolP  = db.prepare('SELECT COUNT(*) n FROM bol_postos').get().n;
    const totBolI  = db.prepare('SELECT COUNT(*) n FROM bol_itens').get().n;

    const certList = db.prepare("SELECT tipo, data_validade, status FROM certidoes ORDER BY data_validade").all();
    const bolList  = db.prepare("SELECT nome, numero_contrato, ativo FROM bol_contratos ORDER BY ativo DESC, id").all();

    console.log('\n\n══════════════════════════════════════════════════════');
    console.log('✅ SETUP CONCLUÍDO — Montana Assessoria');
    console.log('══════════════════════════════════════════════════════');
    console.log(`\n  📋 Certidões: ${totCert}`);
    for (const c of certList) {
      const hoje = '2026-04-07';
      const dv = c.data_validade;
      const diasRestantes = Math.floor((new Date(dv) - new Date(hoje)) / 86400000);
      const alerta = diasRestantes <= 30 ? ' ⚠️  VENCE EM BREVE' : '';
      console.log(`     ${c.tipo}`);
      console.log(`       Válida até ${dv} (${diasRestantes} dias)${alerta}`);
    }

    console.log(`\n  📂 Boletins — Contratos: ${totBolC} | Postos: ${totBolP} | Itens: ${totBolI}`);
    for (const b of bolList) {
      console.log(`     ${b.ativo ? '🟢' : '🔴'} ${b.nome} (nº ${b.numero_contrato})`);
    }
  } else {
    console.log('\n\n⚠️  DRY RUN — nenhuma alteração feita');
  }
}

main().catch(e => { console.error('\n❌ ERRO:', e.message, e.stack); process.exit(1); });
