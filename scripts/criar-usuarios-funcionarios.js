#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
//  Montana App — Criar usuários para funcionários do Ponto
//  Execute no servidor: node scripts/criar-usuarios-funcionarios.js
//  
//  Cria um login para cada funcionário ativo no RH com:
//  - login: primeironome.sobrenome (minúsculas, sem acento)
//  - senha: Montana@2026 (deve ser trocada no primeiro acesso)
//  - role: rh (acesso apenas ao Ponto Eletrônico)
// ═══════════════════════════════════════════════════════════════════

const Database = require('better-sqlite3');
const crypto   = require('crypto');
const path     = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Empresas disponíveis
const EMPRESAS = ['assessoria', 'seguranca', 'portodovau', 'mustang'];

function normalizar(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function gerarLogin(nome) {
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 1) return normalizar(partes[0]);
  const primeiro = normalizar(partes[0]);
  const ultimo   = normalizar(partes[partes.length - 1]);
  return `${primeiro}.${ultimo}`;
}

function hashSenha(senha) {
  return crypto.createHash('sha256').update(senha).digest('hex');
}

const SENHA_PADRAO = 'Montana@2026';

EMPRESAS.forEach(empresa => {
  const dbPath = path.join(DATA_DIR, `${empresa}.db`);
  let db;
  try {
    db = new Database(dbPath);
  } catch (e) {
    console.log(`[${empresa}] DB não encontrado, pulando.`);
    return;
  }

  // Verifica se tabelas existem
  const temFuncionarios = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rh_funcionarios'").get();
  const temUsuarios     = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='usuarios'").get();

  if (!temFuncionarios || !temUsuarios) {
    console.log(`[${empresa}] Tabelas rh_funcionarios/usuarios não encontradas, pulando.`);
    db.close();
    return;
  }

  const funcionarios = db.prepare("SELECT id, nome, cargo FROM rh_funcionarios WHERE ativo=1 ORDER BY nome").all();
  console.log(`\n[${empresa.toUpperCase()}] ${funcionarios.length} funcionário(s) ativo(s):`);

  let criados = 0, existentes = 0;

  const inserir = db.prepare(`
    INSERT INTO usuarios (nome, login, senha_hash, role, empresa, ativo, criado_em)
    VALUES (?, ?, ?, 'rh', ?, 1, datetime('now'))
  `);

  funcionarios.forEach(func => {
    let login = gerarLogin(func.nome);
    // Garante login único
    let sufixo = 1;
    let loginFinal = login;
    while (db.prepare("SELECT id FROM usuarios WHERE login=?").get(loginFinal)) {
      loginFinal = `${login}${sufixo++}`;
    }

    const jaExiste = db.prepare("SELECT id FROM usuarios WHERE login=?").get(loginFinal);
    if (jaExiste) {
      console.log(`  [EXISTE] ${func.nome} → ${loginFinal}`);
      existentes++;
      return;
    }

    try {
      inserir.run(func.nome, loginFinal, hashSenha(SENHA_PADRAO), empresa);
      console.log(`  [CRIADO] ${func.nome} → login: ${loginFinal} | senha: ${SENHA_PADRAO}`);
      criados++;
    } catch (e) {
      console.log(`  [ERRO]   ${func.nome} → ${e.message}`);
    }
  });

  console.log(`  Resumo: ${criados} criados, ${existentes} já existiam`);
  db.close();
});

console.log('\n✅ Concluído! Avise os colaboradores para trocar a senha no primeiro acesso.');
console.log(`   Senha inicial: ${SENHA_PADRAO}`);
