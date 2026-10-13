// Owner dashboard. No framework and no build step: every value from the API is
// inserted with textContent, never as HTML.

const REFRESH_MS = 30_000;
const state = { me: null, tab: null, bookingsRange: 'today', ordersFilter: 'open' };

// ------------------------------------------------------------------ helpers

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'onclick') node.addEventListener('click', value);
    else if (key === 'class') node.className = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const zar = (cents) => {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}R${Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${String(abs % 100).padStart(2, '0')}`;
};

const when = (iso) =>
  new Date(iso).toLocaleString('en-ZA', {
    timeZone: state.me?.timezone ?? 'Africa/Johannesburg',
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });

const LABELS = {
  PENDING: 'Awaiting you', PENDING_DEPOSIT: 'Awaiting deposit', CONFIRMED: 'Confirmed', CANCELLED: 'Cancelled',
  COMPLETED: 'Completed', NO_SHOW: 'No-show', FULFILLED: 'Fulfilled', SUCCEEDED: 'Paid', FAILED: 'Failed', EXPIRED: 'Expired',
};
const TONES = {
  CONFIRMED: 'ok', COMPLETED: 'ok', FULFILLED: 'ok', SUCCEEDED: 'ok',
  PENDING: 'warn', PENDING_DEPOSIT: 'warn',
  CANCELLED: 'bad', NO_SHOW: 'bad', FAILED: 'bad', EXPIRED: '',
};
const badge = (status, labels = LABELS) => el('span', { class: `badge ${TONES[status] ?? ''}` }, labels[status] ?? status);

/** Payment intents have their own vocabulary: PENDING means the customer has not paid yet. */
const PAYMENT_LABELS = { PENDING: 'Awaiting payment', SUCCEEDED: 'Paid', FAILED: 'Failed', CANCELLED: 'Cancelled', EXPIRED: 'Expired' };
const paymentWord = (status) => (PAYMENT_LABELS[status] ?? status).toLowerCase();

const ACTION_LABELS = {
  CONFIRMED: 'Confirm', CANCELLED: 'Cancel', COMPLETED: 'Mark done', NO_SHOW: 'No-show', FULFILLED: 'Mark fulfilled',
};
const DONE_MESSAGES = {
  CONFIRMED: 'Confirmed.', CANCELLED: 'Cancelled.', COMPLETED: 'Marked as done.', NO_SHOW: 'Marked as a no-show.', FULFILLED: 'Marked as fulfilled.',
};

let toastTimer;
function toast(message) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), 6000);
}

class Unauthenticated extends Error {}

async function api(path, options = {}) {
  const response = await fetch(`/api/dashboard${path}`, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
  });
  if (response.status === 401) throw new Unauthenticated();
  const body = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 409) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

// ------------------------------------------------------------------ views

function renderLogin() {
  document.getElementById('app').replaceChildren(
    el('div', { class: 'login' },
      el('h1', {}, 'Log in to your dashboard'),
      el('ol', {},
        el('li', {}, 'Open WhatsApp on the phone registered as the business owner.'),
        el('li', {}, 'Send ', el('strong', {}, 'LOGIN'), ' to your business WhatsApp number.'),
        el('li', {}, 'Tap ', el('strong', {}, 'Open dashboard'), ' in the reply. The link works once.'),
      ),
      el('p', { class: 'sub' }, 'For your security, sessions end after a while and sooner if left idle.'),
    ),
  );
}

function kpi(label, value, extra = {}) {
  return el('div', { class: `kpi ${extra.low ? 'low' : ''}` }, el('div', { class: 'label' }, label), el('div', { class: 'value' }, value));
}

async function changeStatus(kind, id, status, button) {
  if (status === 'CANCELLED' && !confirm('Cancel this? The customer will be told if they messaged in the last 24 hours.')) return;
  button.disabled = true;
  try {
    const result = await api(`/${kind}/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
    if (!result.ok) {
      toast('That change is no longer possible. The list has been refreshed.');
    } else {
      const parts = [DONE_MESSAGES[status] ?? 'Updated.'];
      if (status === 'CONFIRMED' || status === 'CANCELLED') {
        parts.push(result.customerNotified ? 'Customer notified on WhatsApp.' : 'Customer not notified (no message from them in 24 hours): please contact them.');
      }
      if (result.refundRequired) {
        parts.push(result.refundBy === 'OWNER'
          ? 'They had paid, so a refund is due: refund it from your PayFast or Paystack dashboard.'
          : 'They had paid, so a refund is due: it has been flagged for the platform team.');
      }
      toast(parts.join(' '));
    }
  } catch (error) {
    if (error instanceof Unauthenticated) return renderLogin();
    toast('Something went wrong. Please try again.');
  }
  await refresh();
}

function actions(kind, row) {
  if (!row.actions.length) return null;
  return el('div', { class: 'actions' },
    row.actions.map((status) =>
      el('button', {
        class: status === 'CONFIRMED' ? 'primary' : status === 'CANCELLED' || status === 'NO_SHOW' ? 'danger' : '',
        onclick: (event) => changeStatus(kind, row.id, status, event.currentTarget),
      }, ACTION_LABELS[status] ?? status),
    ),
  );
}

function customerLine(customer) {
  return [customer.name ?? 'Customer', ' · ', customer.phoneMasked, ' · ', el('a', { href: customer.chatUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Chat')];
}

function filters(options, current, onPick) {
  return el('div', { class: 'filters', role: 'group' },
    options.map(([value, label]) => el('button', { 'aria-pressed': String(value === current), onclick: () => onPick(value) }, label)),
  );
}

async function bookingsView() {
  const rows = await api(`/bookings?range=${state.bookingsRange}`);
  return [
    filters([['today', 'Today'], ['upcoming', 'Upcoming'], ['past', 'Past']], state.bookingsRange, (value) => { state.bookingsRange = value; refresh(); }),
    rows.length === 0
      ? el('p', { class: 'empty' }, 'No bookings here.')
      : el('div', { class: 'list' }, rows.map((row) =>
          el('div', { class: 'item' },
            el('div', { class: 'top' }, el('span', { class: 'title' }, `${row.when} · ${row.service ?? 'Booking'}`), badge(row.status)),
            el('div', { class: 'meta' }, customerLine(row.customer)),
            el('div', { class: 'meta' },
              row.totalCents ? `Total ${zar(row.totalCents)}` : 'No price set',
              row.payment ? ` · Deposit ${zar(row.payment.amountCents)} ${paymentWord(row.payment.status)}` : '',
              row.holdExpired ? ' · Hold lapsed (unpaid)' : '',
            ),
            actions('bookings', row),
          ))),
  ];
}

async function ordersView() {
  const rows = await api(`/orders?filter=${state.ordersFilter}`);
  return [
    filters([['open', 'Open'], ['all', 'All']], state.ordersFilter, (value) => { state.ordersFilter = value; refresh(); }),
    rows.length === 0
      ? el('p', { class: 'empty' }, 'No orders here.')
      : el('div', { class: 'list' }, rows.map((row) =>
          el('div', { class: 'item' },
            el('div', { class: 'top' }, el('span', { class: 'title' }, `Order ${row.reference} · ${when(row.createdAt)}`), badge(row.status)),
            el('div', { class: 'meta' }, row.items.join(', ') || 'No items'),
            row.fulfilment === 'DELIVERY'
              ? el('div', { class: 'meta' }, '🚚 Deliver to ', el('strong', {}, row.deliveryAddress ?? '(no address)'), row.deliveryFeeCents ? ` · fee ${zar(row.deliveryFeeCents)}` : '')
              : row.fulfilment === 'COLLECTION'
                ? el('div', { class: 'meta' }, '🏪 Collection')
                : null,
            el('div', { class: 'meta' }, customerLine(row.customer)),
            el('div', { class: 'meta' },
              el('span', { class: 'money' }, zar(row.totalCents)),
              row.payment ? ` · Payment ${paymentWord(row.payment.status)}` : '',
            ),
            actions('orders', row),
          ))),
  ];
}

async function paymentsView() {
  const rows = await api('/payments');
  if (rows.length === 0) return [el('p', { class: 'empty' }, 'No payments yet.')];
  return [
    el('div', { class: 'table-wrap' },
      el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'When'), el('th', {}, 'For'), el('th', {}, 'Customer'), el('th', {}, 'Status'), el('th', { class: 'num' }, 'Amount'))),
        el('tbody', {}, rows.map((row) =>
          el('tr', {},
            el('td', {}, when(row.settledAt ?? row.createdAt)),
            el('td', {}, row.for, row.isTest ? ' (test)' : ''),
            el('td', {}, row.customer.name ?? row.customer.phoneMasked),
            el('td', {}, badge(row.status, PAYMENT_LABELS), row.reviewRequired ? el('span', { class: 'badge bad' }, ` Review: ${row.reviewReason ?? 'check'}`) : ''),
            el('td', { class: 'num' }, zar(row.amountCents)),
          ))),
      ),
    ),
  ];
}

async function walletView() {
  const wallet = await api('/wallet');
  return [
    el('div', { class: 'kpis' },
      kpi('Balance', zar(wallet.balanceCents), { low: wallet.balanceCents < wallet.thresholdCents }),
      kpi('Warning below', zar(wallet.thresholdCents)),
    ),
    wallet.transactions.length === 0
      ? el('p', { class: 'empty' }, 'No wallet activity yet.')
      : el('div', { class: 'table-wrap' },
          el('table', {},
            el('thead', {}, el('tr', {}, el('th', {}, 'When'), el('th', {}, 'What'), el('th', { class: 'num' }, 'Amount'), el('th', { class: 'num' }, 'Balance'))),
            el('tbody', {}, wallet.transactions.map((tx) =>
              el('tr', {},
                el('td', {}, when(tx.at)),
                el('td', {}, tx.description),
                el('td', { class: 'num' }, zar(tx.amountCents)),
                el('td', { class: 'num' }, zar(tx.balanceAfterCents)),
              ))),
          ),
        ),
  ];
}

async function saveStock(id, input, button) {
  const raw = input.value.trim();
  const stock = raw === '' ? null : Number(raw);
  if (stock !== null && (!Number.isInteger(stock) || stock < 0 || stock > 100000)) {
    toast('Enter a whole number, or leave it empty to stop tracking stock.');
    return;
  }
  button.disabled = true;
  try {
    const result = await api(`/products/${id}/stock`, { method: 'POST', body: JSON.stringify({ stock }) });
    toast(result.ok ? (stock === null ? 'Stock tracking off.' : `Stock set to ${stock}.`) : 'That product is no longer available.');
  } catch (error) {
    if (error instanceof Unauthenticated) return renderLogin();
    toast('Something went wrong. Please try again.');
  }
  await refresh();
}

async function productsView() {
  const rows = await api('/products');
  if (rows.length === 0) return [el('p', { class: 'empty' }, 'No products yet.')];
  return [
    el('p', { class: 'sub' }, 'Units on hand. Paid and unpaid open orders have already been taken off. Sold-out items are hidden from customers; empty means not tracked.'),
    el('div', { class: 'list' }, rows.map((row) => {
      const input = el('input', { type: 'number', min: '0', max: '100000', step: '1', inputmode: 'numeric', value: row.stock ?? '', 'aria-label': `Stock for ${row.name}`, class: 'stock' });
      return el('div', { class: 'item' },
        el('div', { class: 'top' }, el('span', { class: 'title' }, row.name), row.stock === 0 ? el('span', { class: 'badge bad' }, 'Sold out') : row.stock !== null && row.stock <= 3 ? el('span', { class: 'badge warn' }, 'Low') : null),
        el('div', { class: 'meta' }, zar(row.priceCents)),
        el('div', { class: 'actions' }, input, el('button', { onclick: (event) => saveStock(row.id, input, event.currentTarget) }, 'Save')),
      );
    })),
  ];
}

const TABS = {
  bookings: ['Bookings', bookingsView],
  orders: ['Orders', ordersView],
  products: ['Products', productsView],
  payments: ['Payments', paymentsView],
  wallet: ['Wallet', walletView],
};

function tabsFor(me) {
  return me.industry === 'SALON' ? ['bookings', 'payments', 'wallet'] : ['orders', 'products', 'payments', 'wallet'];
}

async function refresh() {
  try {
    if (!state.me) state.me = await api('/me');
    const me = state.me;
    const tabs = tabsFor(me);
    if (!state.tab || !tabs.includes(state.tab)) state.tab = tabs[0];
    const [summary, content] = await Promise.all([api('/summary'), TABS[state.tab][1]()]);

    const alerts = [];
    if (summary.paymentsNeedingReview > 0) {
      alerts.push(el('div', { class: 'alert bad' }, `${summary.paymentsNeedingReview} payment(s) need your review (see Payments).`));
    }
    if (summary.wallet?.low) {
      alerts.push(el('div', { class: 'alert' }, `Message wallet is low (${zar(summary.wallet.balanceCents)}). Top up to keep replies going out.`));
    }
    const awaiting = summary.awaitingYourConfirmation.bookings + summary.awaitingYourConfirmation.orders;

    document.getElementById('app').replaceChildren(
      el('header', {},
        el('div', { class: 'inner' },
          el('div', {}, el('h1', {}, me.businessName), el('div', { class: 'sub' }, `${me.waDisplayPhone}${me.depositPercent ? ` · ${me.depositPercent}% deposit` : ''}`)),
          el('button', { onclick: logout }, 'Log out'),
        ),
      ),
      el('main', {},
        el('div', { class: 'kpis' },
          kpi('Paid today', zar(summary.today.settledCents)),
          kpi(me.industry === 'SALON' ? 'Bookings today' : 'Payments today', me.industry === 'SALON' ? summary.today.bookings : summary.today.payments),
          kpi('Awaiting you', awaiting),
          kpi('Message wallet', summary.wallet ? zar(summary.wallet.balanceCents) : '—', { low: summary.wallet?.low }),
        ),
        alerts,
        el('nav', { class: 'tabs', role: 'tablist' },
          tabs.map((key) => el('button', { role: 'tab', 'aria-selected': String(key === state.tab), onclick: () => { state.tab = key; refresh(); } }, TABS[key][0])),
        ),
        el('section', { role: 'tabpanel' }, content),
      ),
    );
  } catch (error) {
    if (error instanceof Unauthenticated) return renderLogin();
    toast('Could not load the dashboard. Retrying shortly.');
  }
}

async function logout() {
  try {
    await api('/logout', { method: 'POST' });
  } finally {
    state.me = null;
    renderLogin();
  }
}

refresh();
setInterval(() => {
  // Don't re-render under someone typing a stock figure.
  if (document.visibilityState === 'visible' && state.me && document.activeElement?.tagName !== 'INPUT') refresh();
}, REFRESH_MS);
