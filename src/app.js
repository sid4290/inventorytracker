const path = require('node:path');
const express = require('express');
const cookieSession = require('cookie-session');
const { CATEGORIES } = require('./db');
const s = require('./services');

function createApp(db) {
  const app = express();
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd && !process.env.SESSION_SECRET) throw new Error('SESSION_SECRET must be set in production');
  if (isProd) app.set('trust proxy', 1); // behind a reverse proxy / PaaS load balancer
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: false }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(cookieSession({
    name: 'inventory.session',
    keys: [process.env.SESSION_SECRET || 'inventory-tracker-dev-secret'],
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    maxAge: 8 * 60 * 60 * 1000,
  }));

  app.get('/health', (req, res) => {
    try { db.prepare('SELECT 1').get(); res.json({ status: 'ok' }); }
    catch (err) { res.status(503).json({ status: 'error', message: err.message }); }
  });

  // Flash messages + template locals
  app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.canModify = req.session.user ? s.canModifyBom(req.session.user.role) : false;
    res.locals.flash = req.session.flash || null;
    res.locals.categories = CATEGORIES;
    res.locals.path = req.path;
    delete req.session.flash;
    next();
  });
  const flash = (req, type, text) => { req.session.flash = { type, text }; };

  const requireLogin = (req, res, next) => (req.session.user ? next() : res.redirect('/login'));
  const requireModifier = (req, res, next) => {
    if (res.locals.canModify) return next();
    flash(req, 'error', 'Only an Inventory Manager or System Administrator can do that.');
    res.redirect('/boms');
  };

  // ---- INV-SCR-01 Login (FR1, FR2, FR17) ----
  app.get('/login', (req, res) => (req.session.user ? res.redirect('/') : res.render('login', { error: null, username: '' })));
  app.post('/login', (req, res) => {
    const user = s.authenticate(db, req.body.username, req.body.password);
    if (!user) return res.status(401).render('login', { error: 'Username or password is incorrect.', username: req.body.username || '' });
    req.session.user = user;
    res.redirect('/');
  });
  app.post('/logout', (req, res) => {
    req.session = null;
    res.redirect('/login');
  });

  app.use(requireLogin);

  // ---- INV-SCR-02 Dashboard ----
  app.get('/', (req, res) => res.render('dashboard', { summary: s.dashboardSummary(db), lowStock: s.listLowStock(db).slice(0, 5) }));

  // ---- INV-SCR-03 BoM List (FR3–FR6, FR12, FR15, FR16) ----
  app.get('/boms', (req, res) => {
    const search = req.query.q || '';
    const status = req.query.status || 'All';
    res.render('bom-list', { boms: s.listBoms(db, { search, status }), search, status });
  });

  // ---- INV-SCR-04 Add BoM (FR3, FR4, FR7, FR13) ----
  app.get('/boms/new', (req, res) => res.render('bom-form', { mode: 'new', values: {}, errors: {} }));
  app.post('/boms/new', (req, res) => {
    try {
      const created = s.createBom(db, req.body, req.session.user.user_id);
      flash(req, 'ok', `Added ${created.bom_name} (${created.bom_id}) with an opening balance of ${created.opening_balance}.`);
      res.redirect('/boms');
    } catch (err) {
      if (!(err instanceof s.ValidationError)) throw err;
      res.status(422).render('bom-form', { mode: 'new', values: req.body, errors: err.errors || {} });
    }
  });

  // ---- INV-SCR-05 Edit BoM (FR5, FR7, FR14) ----
  app.get('/boms/:id/edit', requireModifier, (req, res) => {
    const bom = s.getBom(db, req.params.id);
    if (!bom) return res.status(404).render('not-found');
    res.render('bom-form', { mode: 'edit', values: { ...bom, balance: bom.current_balance }, errors: {} });
  });
  app.post('/boms/:id/edit', requireModifier, (req, res) => {
    try {
      const updated = s.updateBom(db, req.params.id, req.body, req.session.user.role);
      flash(req, 'ok', `Saved changes to ${updated.bom_name}.`);
      res.redirect('/boms');
    } catch (err) {
      if (!(err instanceof s.ValidationError)) throw err;
      res.status(422).render('bom-form', { mode: 'edit', values: { ...req.body, bom_id: req.params.id }, errors: err.errors || {} });
    }
  });
  app.post('/boms/:id/delete', requireModifier, (req, res) => {
    s.deleteBom(db, req.params.id, req.session.user.role);
    flash(req, 'ok', `Deleted ${req.params.id}.`);
    res.redirect('/boms');
  });

  // ---- INV-SCR-06 Stock Transaction (FR8, FR9, FR10) ----
  app.get('/transactions', (req, res) => res.render('transaction', {
    boms: s.listBoms(db), values: { bom_id: req.query.bom || '', txn_type: req.query.type || 'IN' }, error: null,
    recent: s.listTransactions(db, { limit: 15 }),
  }));
  app.post('/transactions', (req, res) => {
    try {
      const { bom, purchaseOrder } = s.recordTransaction(db, req.body, req.session.user.user_id);
      const verb = req.body.txn_type === 'IN' ? 'Received' : 'Issued';
      let text = `${verb} ${req.body.quantity} × ${bom.bom_name}. Balance is now ${bom.current_balance}.`;
      if (purchaseOrder) text += ` Balance is at or below safety stock — purchase order PO-${purchaseOrder.po_id} was generated.`;
      flash(req, purchaseOrder ? 'warn' : 'ok', text);
      res.redirect('/transactions');
    } catch (err) {
      if (!(err instanceof s.ValidationError)) throw err;
      res.status(422).render('transaction', { boms: s.listBoms(db), values: req.body, error: err.message, recent: s.listTransactions(db, { limit: 15 }) });
    }
  });

  // ---- INV-SCR-07 Low-Stock Status (FR10b, FR11) ----
  app.get('/low-stock', (req, res) => res.render('low-stock', { items: s.listLowStock(db) }));

  // ---- INV-SCR-08 Purchase Orders (SDD FR-10) ----
  app.get('/purchase-orders', (req, res) => res.render('purchase-orders', { orders: s.listPurchaseOrders(db) }));
  app.post('/purchase-orders/:id/review', requireModifier, (req, res) => {
    s.reviewPurchaseOrder(db, Number(req.params.id), req.session.user);
    flash(req, 'ok', `Marked PO-${req.params.id} as reviewed.`);
    res.redirect('/purchase-orders');
  });

  app.use((req, res) => res.status(404).render('not-found'));

  // Global error handler — never leak stack traces to the browser
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err);
    res.status(err.status || 500).render('error', { message: isProd ? 'Something went wrong. Please try again.' : err.message });
  });
  return app;
}

module.exports = { createApp };
