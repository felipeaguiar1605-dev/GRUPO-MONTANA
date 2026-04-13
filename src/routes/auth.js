const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../../config/database');

// Página de login
router.get('/', (req, res) => {
    if (req.session.usuario) return res.redirect('/dashboard');
    res.redirect('/login');
});

router.get('/login', (req, res) => {
    if (req.session.usuario) return res.redirect('/dashboard');
    res.render('login', { title: 'Login', erro: null });
});

// Processar login
router.post('/login', (req, res) => {
    const { email, senha } = req.body;

    const usuario = db.prepare('SELECT * FROM usuarios WHERE email = ? AND ativo = 1').get(email);
    if (!usuario || !bcrypt.compareSync(senha, usuario.senha)) {
        return res.render('login', { title: 'Login', erro: 'Email ou senha inválidos' });
    }

    // Atualizar último acesso
    db.prepare('UPDATE usuarios SET ultimo_acesso = CURRENT_TIMESTAMP WHERE id = ?').run(usuario.id);

    // Buscar empresas do usuário
    const empresas = db.prepare(`
        SELECT e.* FROM empresas e
        JOIN usuario_empresas ue ON e.id = ue.empresa_id
        WHERE ue.usuario_id = ? AND e.ativa = 1
    `).all(usuario.id);

    req.session.usuario = {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        perfil: usuario.perfil
    };
    req.session.empresas = empresas;

    // Se tem empresa padrão, seleciona automaticamente
    if (usuario.empresa_padrao_id && empresas.find(e => e.id === usuario.empresa_padrao_id)) {
        req.session.empresaAtual = empresas.find(e => e.id === usuario.empresa_padrao_id);
        return res.redirect('/dashboard');
    }

    // Se só tem uma empresa, seleciona automaticamente
    if (empresas.length === 1) {
        req.session.empresaAtual = empresas[0];
        return res.redirect('/dashboard');
    }

    res.redirect('/selecionar-empresa');
});

// Selecionar empresa
router.get('/selecionar-empresa', (req, res) => {
    if (!req.session.usuario) return res.redirect('/login');
    res.render('selecionar-empresa', {
        title: 'Selecionar Empresa',
        empresas: req.session.empresas || []
    });
});

router.post('/selecionar-empresa', (req, res) => {
    if (!req.session.usuario) return res.redirect('/login');
    const { empresa_id } = req.body;
    const empresa = (req.session.empresas || []).find(e => e.id === parseInt(empresa_id));
    if (empresa) {
        req.session.empresaAtual = empresa;
    }
    res.redirect('/dashboard');
});

// Trocar empresa (via header)
router.get('/trocar-empresa/:id', (req, res) => {
    if (!req.session.usuario) return res.redirect('/login');
    const empresa = (req.session.empresas || []).find(e => e.id === parseInt(req.params.id));
    if (empresa) {
        req.session.empresaAtual = empresa;
    }
    res.redirect(req.get('Referer') || '/dashboard');
});

// Logout
router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

module.exports = router;
