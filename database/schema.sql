-- ============================================
-- ERP Nevada Embalagens & Montreal Máquinas
-- Schema do Banco de Dados
-- ============================================

-- Empresas do grupo
CREATE TABLE IF NOT EXISTS empresas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    razao_social TEXT NOT NULL,
    nome_fantasia TEXT NOT NULL,
    cnpj TEXT UNIQUE NOT NULL,
    inscricao_estadual TEXT,
    endereco TEXT,
    cidade TEXT,
    estado TEXT DEFAULT 'GO',
    cep TEXT,
    telefone TEXT,
    email TEXT,
    tipo TEXT CHECK(tipo IN ('atacado', 'varejo', 'ambos')) DEFAULT 'ambos',
    ativa INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Usuários do sistema
CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    senha TEXT NOT NULL,
    perfil TEXT CHECK(perfil IN ('admin', 'gerente', 'vendedor', 'caixa', 'estoquista')) DEFAULT 'vendedor',
    empresa_padrao_id INTEGER REFERENCES empresas(id),
    ativo INTEGER DEFAULT 1,
    ultimo_acesso DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Acesso do usuário por empresa
CREATE TABLE IF NOT EXISTS usuario_empresas (
    usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
    empresa_id INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
    PRIMARY KEY (usuario_id, empresa_id)
);

-- ============================================
-- PRODUTOS E CATEGORIAS
-- ============================================

CREATE TABLE IF NOT EXISTS categorias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    nome TEXT NOT NULL,
    descricao TEXT,
    ativa INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS unidades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sigla TEXT NOT NULL,
    descricao TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    codigo TEXT,
    codigo_barras TEXT,
    nome TEXT NOT NULL,
    descricao TEXT,
    categoria_id INTEGER REFERENCES categorias(id),
    unidade_id INTEGER REFERENCES unidades(id),
    ncm TEXT,
    cfop_venda TEXT,
    preco_custo REAL DEFAULT 0,
    preco_venda REAL DEFAULT 0,
    preco_atacado REAL DEFAULT 0,
    margem_lucro REAL DEFAULT 0,
    estoque_minimo REAL DEFAULT 0,
    estoque_maximo REAL DEFAULT 0,
    localizacao TEXT,
    peso REAL DEFAULT 0,
    ativo INTEGER DEFAULT 1,
    foto TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_produtos_empresa ON produtos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_produtos_categoria ON produtos(categoria_id);
CREATE INDEX IF NOT EXISTS idx_produtos_codigo ON produtos(codigo);
CREATE INDEX IF NOT EXISTS idx_produtos_codigo_barras ON produtos(codigo_barras);

-- ============================================
-- ESTOQUE
-- ============================================

CREATE TABLE IF NOT EXISTS estoque (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    produto_id INTEGER NOT NULL REFERENCES produtos(id),
    quantidade REAL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(empresa_id, produto_id)
);

CREATE TABLE IF NOT EXISTS estoque_movimentacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    produto_id INTEGER NOT NULL REFERENCES produtos(id),
    tipo TEXT CHECK(tipo IN ('entrada', 'saida', 'ajuste', 'transferencia', 'devolucao')) NOT NULL,
    quantidade REAL NOT NULL,
    quantidade_anterior REAL DEFAULT 0,
    quantidade_posterior REAL DEFAULT 0,
    custo_unitario REAL DEFAULT 0,
    documento_tipo TEXT,
    documento_id INTEGER,
    observacao TEXT,
    usuario_id INTEGER REFERENCES usuarios(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_estoque_mov_empresa ON estoque_movimentacoes(empresa_id);
CREATE INDEX IF NOT EXISTS idx_estoque_mov_produto ON estoque_movimentacoes(produto_id);

-- ============================================
-- CLIENTES
-- ============================================

CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    tipo_pessoa TEXT CHECK(tipo_pessoa IN ('PF', 'PJ')) DEFAULT 'PF',
    nome TEXT NOT NULL,
    cpf_cnpj TEXT,
    rg_ie TEXT,
    email TEXT,
    telefone TEXT,
    celular TEXT,
    endereco TEXT,
    numero TEXT,
    complemento TEXT,
    bairro TEXT,
    cidade TEXT,
    estado TEXT DEFAULT 'GO',
    cep TEXT,
    limite_credito REAL DEFAULT 0,
    observacoes TEXT,
    ativo INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_clientes_empresa ON clientes(empresa_id);
CREATE INDEX IF NOT EXISTS idx_clientes_cpf_cnpj ON clientes(cpf_cnpj);

-- ============================================
-- FORNECEDORES
-- ============================================

CREATE TABLE IF NOT EXISTS fornecedores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    razao_social TEXT NOT NULL,
    nome_fantasia TEXT,
    cnpj TEXT,
    inscricao_estadual TEXT,
    contato TEXT,
    email TEXT,
    telefone TEXT,
    celular TEXT,
    endereco TEXT,
    numero TEXT,
    complemento TEXT,
    bairro TEXT,
    cidade TEXT,
    estado TEXT,
    cep TEXT,
    prazo_entrega INTEGER DEFAULT 0,
    condicao_pagamento TEXT,
    observacoes TEXT,
    ativo INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fornecedores_empresa ON fornecedores(empresa_id);

-- ============================================
-- VENDEDORES E COMISSÕES
-- ============================================

CREATE TABLE IF NOT EXISTS vendedores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    nome TEXT NOT NULL,
    cpf TEXT,
    telefone TEXT,
    email TEXT,
    comissao_percentual REAL DEFAULT 0,
    meta_mensal REAL DEFAULT 0,
    ativo INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- VENDAS
-- ============================================

CREATE TABLE IF NOT EXISTS vendas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    numero TEXT,
    cliente_id INTEGER REFERENCES clientes(id),
    vendedor_id INTEGER REFERENCES vendedores(id),
    usuario_id INTEGER REFERENCES usuarios(id),
    data_venda DATETIME DEFAULT CURRENT_TIMESTAMP,
    tipo TEXT CHECK(tipo IN ('varejo', 'atacado')) DEFAULT 'varejo',
    subtotal REAL DEFAULT 0,
    desconto_percentual REAL DEFAULT 0,
    desconto_valor REAL DEFAULT 0,
    acrescimo REAL DEFAULT 0,
    total REAL DEFAULT 0,
    forma_pagamento TEXT CHECK(forma_pagamento IN ('dinheiro', 'pix', 'cartao_debito', 'cartao_credito', 'boleto', 'prazo', 'cheque')) DEFAULT 'dinheiro',
    parcelas INTEGER DEFAULT 1,
    status TEXT CHECK(status IN ('aberta', 'finalizada', 'cancelada', 'devolvida')) DEFAULT 'aberta',
    observacoes TEXT,
    nfe_numero TEXT,
    nfe_status TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS venda_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venda_id INTEGER NOT NULL REFERENCES vendas(id) ON DELETE CASCADE,
    produto_id INTEGER NOT NULL REFERENCES produtos(id),
    quantidade REAL NOT NULL,
    preco_unitario REAL NOT NULL,
    desconto REAL DEFAULT 0,
    total REAL NOT NULL,
    comissao_percentual REAL DEFAULT 0,
    comissao_valor REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS comissoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    vendedor_id INTEGER NOT NULL REFERENCES vendedores(id),
    venda_id INTEGER NOT NULL REFERENCES vendas(id),
    valor REAL NOT NULL,
    percentual REAL NOT NULL,
    status TEXT CHECK(status IN ('pendente', 'paga', 'cancelada')) DEFAULT 'pendente',
    data_pagamento DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vendas_empresa ON vendas(empresa_id);
CREATE INDEX IF NOT EXISTS idx_vendas_cliente ON vendas(cliente_id);
CREATE INDEX IF NOT EXISTS idx_vendas_data ON vendas(data_venda);

-- ============================================
-- COMPRAS
-- ============================================

CREATE TABLE IF NOT EXISTS compras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    numero TEXT,
    fornecedor_id INTEGER REFERENCES fornecedores(id),
    usuario_id INTEGER REFERENCES usuarios(id),
    data_compra DATETIME DEFAULT CURRENT_TIMESTAMP,
    data_entrega DATETIME,
    subtotal REAL DEFAULT 0,
    desconto REAL DEFAULT 0,
    frete REAL DEFAULT 0,
    total REAL DEFAULT 0,
    forma_pagamento TEXT,
    parcelas INTEGER DEFAULT 1,
    status TEXT CHECK(status IN ('cotacao', 'pedido', 'recebida', 'cancelada')) DEFAULT 'pedido',
    observacoes TEXT,
    nfe_chave TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS compra_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    compra_id INTEGER NOT NULL REFERENCES compras(id) ON DELETE CASCADE,
    produto_id INTEGER NOT NULL REFERENCES produtos(id),
    quantidade REAL NOT NULL,
    preco_unitario REAL NOT NULL,
    desconto REAL DEFAULT 0,
    total REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_compras_empresa ON compras(empresa_id);
CREATE INDEX IF NOT EXISTS idx_compras_fornecedor ON compras(fornecedor_id);

-- ============================================
-- FINANCEIRO - CONTAS A PAGAR
-- ============================================

CREATE TABLE IF NOT EXISTS contas_pagar (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    fornecedor_id INTEGER REFERENCES fornecedores(id),
    compra_id INTEGER REFERENCES compras(id),
    descricao TEXT NOT NULL,
    categoria TEXT,
    valor REAL NOT NULL,
    data_emissao DATE NOT NULL,
    data_vencimento DATE NOT NULL,
    data_pagamento DATE,
    valor_pago REAL DEFAULT 0,
    juros REAL DEFAULT 0,
    multa REAL DEFAULT 0,
    desconto REAL DEFAULT 0,
    forma_pagamento TEXT,
    documento TEXT,
    parcela INTEGER DEFAULT 1,
    total_parcelas INTEGER DEFAULT 1,
    status TEXT CHECK(status IN ('pendente', 'paga', 'vencida', 'cancelada')) DEFAULT 'pendente',
    observacoes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cp_empresa ON contas_pagar(empresa_id);
CREATE INDEX IF NOT EXISTS idx_cp_vencimento ON contas_pagar(data_vencimento);
CREATE INDEX IF NOT EXISTS idx_cp_status ON contas_pagar(status);

-- ============================================
-- FINANCEIRO - CONTAS A RECEBER
-- ============================================

CREATE TABLE IF NOT EXISTS contas_receber (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    cliente_id INTEGER REFERENCES clientes(id),
    venda_id INTEGER REFERENCES vendas(id),
    descricao TEXT NOT NULL,
    categoria TEXT,
    valor REAL NOT NULL,
    data_emissao DATE NOT NULL,
    data_vencimento DATE NOT NULL,
    data_recebimento DATE,
    valor_recebido REAL DEFAULT 0,
    juros REAL DEFAULT 0,
    multa REAL DEFAULT 0,
    desconto REAL DEFAULT 0,
    forma_pagamento TEXT,
    documento TEXT,
    parcela INTEGER DEFAULT 1,
    total_parcelas INTEGER DEFAULT 1,
    status TEXT CHECK(status IN ('pendente', 'recebida', 'vencida', 'cancelada')) DEFAULT 'pendente',
    observacoes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cr_empresa ON contas_receber(empresa_id);
CREATE INDEX IF NOT EXISTS idx_cr_vencimento ON contas_receber(data_vencimento);
CREATE INDEX IF NOT EXISTS idx_cr_status ON contas_receber(status);

-- ============================================
-- FLUXO DE CAIXA
-- ============================================

CREATE TABLE IF NOT EXISTS fluxo_caixa (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    tipo TEXT CHECK(tipo IN ('entrada', 'saida')) NOT NULL,
    categoria TEXT,
    descricao TEXT NOT NULL,
    valor REAL NOT NULL,
    data_movimento DATE NOT NULL,
    forma_pagamento TEXT,
    documento_tipo TEXT,
    documento_id INTEGER,
    usuario_id INTEGER REFERENCES usuarios(id),
    observacoes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fluxo_empresa ON fluxo_caixa(empresa_id);
CREATE INDEX IF NOT EXISTS idx_fluxo_data ON fluxo_caixa(data_movimento);
