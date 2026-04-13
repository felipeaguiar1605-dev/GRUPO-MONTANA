require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Session
app.use(session({
    store: new SQLiteStore({ db: 'sessions.db', dir: './database' }),
    secret: process.env.SESSION_SECRET || 'nevada-montreal-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Variáveis globais para views
app.use((req, res, next) => {
    res.locals.usuario = req.session.usuario || null;
    res.locals.empresaAtual = req.session.empresaAtual || null;
    res.locals.empresas = req.session.empresas || [];
    res.locals.moment = require('moment');
    res.locals.formatMoney = (val) => {
        return (val || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    };
    res.locals.formatNumber = (val) => {
        return (val || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    };
    res.locals.mensagem = req.query.msg || null;
    res.locals.erro = req.query.erro || null;
    res.locals.title = '';
    next();
});

// Routes
const authMiddleware = require('./src/middleware/auth');
app.use('/', require('./src/routes/auth'));
app.use('/dashboard', authMiddleware, require('./src/routes/dashboard'));
app.use('/empresa', authMiddleware, require('./src/routes/empresa'));
app.use('/produtos', authMiddleware, require('./src/routes/produtos'));
app.use('/categorias', authMiddleware, require('./src/routes/categorias'));
app.use('/estoque', authMiddleware, require('./src/routes/estoque'));
app.use('/clientes', authMiddleware, require('./src/routes/clientes'));
app.use('/fornecedores', authMiddleware, require('./src/routes/fornecedores'));
app.use('/vendas', authMiddleware, require('./src/routes/vendas'));
app.use('/compras', authMiddleware, require('./src/routes/compras'));
app.use('/financeiro', authMiddleware, require('./src/routes/financeiro'));
app.use('/comissoes', authMiddleware, require('./src/routes/comissoes'));
app.use('/relatorios', authMiddleware, require('./src/routes/relatorios'));
app.use('/vendedores', authMiddleware, require('./src/routes/vendedores'));

// 404
app.use((req, res) => {
    res.status(404).render('404', { title: 'Página não encontrada' });
});

// Error handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).render('erro', { title: 'Erro', erro: err.message });
});

app.listen(PORT, () => {
    console.log(`Nevada & Montreal ERP rodando na porta ${PORT}`);
    console.log(`http://localhost:${PORT}`);
});
