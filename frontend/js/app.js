// Entry point: registers views, loads the session, renders.
import { route, errorPage, loadMe, render } from './core.js';
import './views/public.js';
import './views/auth.js';
import './views/me.js';
import './views/arena.js';
import './views/manage.js';
import './views/admin.js';
import './views/guide.js';

route('.*', { notFound: true, view: () => errorPage(404, "That page doesn't exist.") });
try { await loadMe(); } catch { /* server unreachable: render anyway */ }
render();
