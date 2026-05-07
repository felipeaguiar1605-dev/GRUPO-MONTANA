/**
 * Montana ERP — Política de senha (NIST 800-63B)
 */
const BLOCKLIST = new Set([
  '123456','123456789','12345678','12345','1234567','password','senha','admin',
  'qwerty','abc123','iloveyou','000000','111111','123123','admin123','senha123',
  'montana','montana2026','montana123','vigilancia','seguranca','assessoria',
  'brasil','brasilia','palmas','tocantins','master','sistema','usuario','user',
  'gerente','financeiro','contador','rh','folha','contas','fiscal','contrato',
  'p@ssword','p@ssw0rd','admin@123','senha@123','mudar123','123mudar','trocar123'
]);

const MIN_LENGTH = parseInt(process.env.PASSWORD_MIN_LENGTH || '12', 10);

function validate(senha, ctx = {}) {
  const errors = [];
  if (typeof senha !== 'string') return { ok: false, errors: ['Senha deve ser texto'] };

  if (senha.length < MIN_LENGTH) errors.push(`Mínimo ${MIN_LENGTH} caracteres`);
  if (!/[a-z]/.test(senha)) errors.push('Deve conter letra minúscula');
  if (!/[A-Z]/.test(senha)) errors.push('Deve conter letra maiúscula');
  if (!/[0-9]/.test(senha)) errors.push('Deve conter número');
  if (!/[^A-Za-z0-9]/.test(senha)) errors.push('Deve conter caractere especial');

  const lc = senha.toLowerCase();
  if (BLOCKLIST.has(lc)) errors.push('Senha muito comum — escolha outra');

  if (ctx.usuario && lc.includes(ctx.usuario.toLowerCase())) {
    errors.push('Senha não pode conter o usuário');
  }
  if (ctx.nome) {
    const partes = ctx.nome.toLowerCase().split(/\s+/).filter(p => p.length >= 4);
    if (partes.some(p => lc.includes(p))) errors.push('Senha não pode conter o nome');
  }

  if (/0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef|qwer|wert|erty/i.test(senha)) {
    errors.push('Senha não pode conter sequências previsíveis');
  }
  if (/(.)\1{3,}/.test(senha)) errors.push('Senha não pode ter 4+ caracteres repetidos');

  return { ok: errors.length === 0, errors };
}

function score(senha) {
  if (!senha) return 0;
  let s = 0;
  s += Math.min(senha.length * 4, 40);
  if (/[a-z]/.test(senha)) s += 10;
  if (/[A-Z]/.test(senha)) s += 10;
  if (/[0-9]/.test(senha)) s += 10;
  if (/[^A-Za-z0-9]/.test(senha)) s += 15;
  const unique = new Set(senha).size;
  s += Math.min(unique * 2, 15);
  return Math.min(s, 100);
}

module.exports = { validate, score, MIN_LENGTH, BLOCKLIST };
