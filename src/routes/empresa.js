const express = require('express');
const router = express.Router();
const db = require('../../config/database');

// GET / - Exibir detalhes da empresa atual
router.get('/', (req, res) => {
    const empresaId = req.session.empresaAtual.id;

    const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(empresaId);

    if (!empresa) {
        return res.redirect('/dashboard?erro=Empresa+nao+encontrada');
    }

    res.render('empresa/index', {
        title: 'Dados da Empresa',
        empresa,
        msg: req.query.msg || null,
        erro: req.query.erro || null
    });
});

// POST /atualizar - Atualizar dados da empresa
router.post('/atualizar', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const {
        razao_social, nome_fantasia, cnpj, inscricao_estadual,
        endereco, cidade, estado, cep, telefone, email, tipo
    } = req.body;

    try {
        const result = db.prepare(`
            UPDATE empresas SET
                razao_social = ?, nome_fantasia = ?, cnpj = ?, inscricao_estadual = ?,
                endereco = ?, cidade = ?, estado = ?, cep = ?,
                telefone = ?, email = ?, tipo = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(
            razao_social || null,
            nome_fantasia || null,
            cnpj || null,
            inscricao_estadual || null,
            endereco || null,
            cidade || null,
            estado || null,
            cep || null,
            telefone || null,
            email || null,
            tipo || null,
            empresaId
        );

        if (result.changes === 0) {
            return res.redirect('/empresa?erro=Empresa+nao+encontrada');
        }

        // Atualizar dados na sessao
        const empresaAtualizada = db.prepare('SELECT * FROM empresas WHERE id = ?').get(empresaId);
        if (empresaAtualizada) {
            req.session.empresaAtual = empresaAtualizada;

            // Atualizar tambem na lista de empresas da sessao
            if (req.session.empresas) {
                const idx = req.session.empresas.findIndex(e => e.id === empresaId);
                if (idx !== -1) {
                    req.session.empresas[idx] = empresaAtualizada;
                }
            }
        }

        res.redirect('/empresa?msg=Dados+da+empresa+atualizados+com+sucesso');
    } catch (err) {
        console.error('Erro ao atualizar empresa:', err);
        res.redirect('/empresa?erro=Erro+ao+atualizar+dados+da+empresa');
    }
});

module.exports = router;
