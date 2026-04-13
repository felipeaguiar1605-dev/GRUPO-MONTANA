module.exports = function authMiddleware(req, res, next) {
    if (!req.session.usuario) {
        return res.redirect('/login');
    }
    if (!req.session.empresaAtual) {
        return res.redirect('/selecionar-empresa');
    }
    next();
};
