const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const dbPath = path.resolve(process.env.DB_PATH || './database/nevada_montreal.db');
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

console.log('Inicializando banco de dados...');

// Executar schema
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);
console.log('Schema criado com sucesso.');

// Inserir empresas padrão
const insertEmpresa = db.prepare(`
    INSERT OR IGNORE INTO empresas (razao_social, nome_fantasia, cnpj, tipo)
    VALUES (?, ?, ?, ?)
`);

insertEmpresa.run('Nevada Embalagens e Produtos de Limpeza LTDA', 'Nevada Embalagens', '00.000.000/0001-01', 'ambos');
insertEmpresa.run('Montreal Máquinas e Ferramentas LTDA', 'Montreal Máquinas', '00.000.000/0001-02', 'ambos');
console.log('Empresas cadastradas.');

// Inserir unidades padrão
const insertUnidade = db.prepare('INSERT OR IGNORE INTO unidades (sigla, descricao) VALUES (?, ?)');
const unidades = [
    ['UN', 'Unidade'], ['PC', 'Peça'], ['CX', 'Caixa'], ['PCT', 'Pacote'],
    ['FD', 'Fardo'], ['KG', 'Quilograma'], ['LT', 'Litro'], ['MT', 'Metro'],
    ['M2', 'Metro Quadrado'], ['GL', 'Galão'], ['RL', 'Rolo'], ['SC', 'Saco'],
    ['DZ', 'Dúzia'], ['PR', 'Par'], ['JG', 'Jogo']
];
unidades.forEach(u => insertUnidade.run(u[0], u[1]));
console.log('Unidades cadastradas.');

// Inserir admin padrão
const senhaHash = bcrypt.hashSync('admin123', 10);
const insertUsuario = db.prepare(`
    INSERT OR IGNORE INTO usuarios (nome, email, senha, perfil, empresa_padrao_id)
    VALUES (?, ?, ?, ?, ?)
`);
insertUsuario.run('Administrador', 'admin@grupo.com', senhaHash, 'admin', 1);
console.log('Usuário admin criado (admin@grupo.com / admin123)');

// Vincular admin às duas empresas
const insertVinculo = db.prepare('INSERT OR IGNORE INTO usuario_empresas (usuario_id, empresa_id) VALUES (?, ?)');
insertVinculo.run(1, 1);
insertVinculo.run(1, 2);

console.log('Banco de dados inicializado com sucesso!');
db.close();
