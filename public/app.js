let productsCache = [];

async function fetchProducts() {
  const res = await fetch('/api/products');
  if (!res.ok) throw new Error('Failed to load products');
  return res.json();
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k === 'class') e.className = attrs[k];
    else if (k === 'html') e.innerHTML = attrs[k];
    else e.setAttribute(k, attrs[k]);
  }
  for (const c of children) {
    if (typeof c === 'string') e.appendChild(document.createTextNode(c));
    else if (c) e.appendChild(c);
  }
  return e;
}

function groupByBrand(products) {
  const map = new Map();
  for (const p of products) {
    const brand = p.brand || 'Other';
    if (!map.has(brand)) map.set(brand, []);
    map.get(brand).push(p);
  }
  return Array.from(map.entries()); // [ [brand, products], ... ]
}

function groupByType(items) {
  const map = new Map();
  for (const p of items) {
    const t = p.type || 'Other';
    if (!map.has(t)) map.set(t, []);
    map.get(t).push(p);
  }
  return Array.from(map.entries());
}

function groupByTag(products) {
  const map = new Map();
  for (const p of products) {
    const tags = Array.isArray(p.tags) && p.tags.length ? p.tags : ['Other'];
    for (const t of tags) {
      if (!map.has(t)) map.set(t, []);
      map.get(t).push(p);
    }
  }
  return Array.from(map.entries());
}

function renderProducts(products) {
  const container = document.getElementById('products');
  container.innerHTML = '';

  const groups = groupByBrand(products);
  for (const [brand, items] of groups) {
    const section = el('section', { class: 'brand-section' },
      el('h2', { class: 'brand-title' }, brand)
    );

    // group items by type within the brand
    const types = groupByType(items);
    for (const [type, titems] of types) {
      const typeHeader = el('h3', { class: 'type-header' }, type);
      const grid = el('div', { class: 'brand-grid' });

      for (const p of titems) {
        const card = el('article', { class: 'product-card' },
          el('img', { src: p.image, alt: p.name, loading: 'lazy', onerror: "this.onerror=null;this.src='/fallback.svg'" }),
          el('div', { class: 'meta' },
            el('h3', {}, p.name),
            el('span', { class: 'type-badge' }, p.type || '')
          ),
          el('p', { class: 'desc' }, p.description),
          el('div', { class: 'price' }, `$${p.price}`),
          el('button', { class: 'inquire', 'data-id': p.id, 'data-name': p.name }, 'Inquire')
        );
        grid.appendChild(card);
      }

      section.appendChild(typeHeader);
      section.appendChild(grid);
    }

    container.appendChild(section);
  }
}

function renderGrouped(products, mode = 'brand') {
  const container = document.getElementById('products');
  container.innerHTML = '';

  // If there are no products to show, render a helpful no-results message
  if (!products || products.length === 0) {
    const no = el('div', { class: 'no-results' }, 'No products found matching your search or filters.', el('small', {}, 'Try different keywords or clear the search.'));
    container.appendChild(no);
    return;
  }

  if (mode === 'none') {
    // flat list
    const grid = document.createElement('div');
    grid.className = 'brand-grid';
    for (const p of products) {
      const card = createProductCard(p);
      grid.appendChild(card);
    }
    container.appendChild(grid);
    return;
  }

  let groups = [];
  if (mode === 'brand') groups = groupByBrand(products);
  else if (mode === 'type') {
    // group by type across all products
    const map = new Map();
    for (const p of products) {
      const t = p.type || 'Other';
      if (!map.has(t)) map.set(t, []);
      map.get(t).push(p);
    }
    groups = Array.from(map.entries());
  } else if (mode === 'tag') groups = groupByTag(products);

  for (const [groupName, items] of groups) {
    const section = el('section', { class: 'brand-section' },
      el('h2', { class: 'brand-title' }, groupName)
    );

    const grid = el('div', { class: 'brand-grid' });
    for (const p of items) grid.appendChild(createProductCard(p));

    section.appendChild(grid);
    container.appendChild(section);
  }
}

function createProductCard(p) {
  return el('article', { class: 'product-card' },
    el('img', { src: p.image, alt: p.name, loading: 'lazy', onerror: "this.onerror=null;this.src='/fallback.svg'" }),
    el('div', { class: 'meta' },
      el('h3', {}, p.name),
      el('span', { class: 'type-badge' }, p.type || '')
    ),
    el('p', { class: 'desc' }, p.description),
    el('div', { class: 'price' }, `$${p.price}`),
    el('button', { class: 'inquire', 'data-id': p.id, 'data-name': p.name }, 'Inquire')
  );
}

function setupInquiryForm() {
  const form = document.getElementById('inquiry-form');
  const productIdInput = document.getElementById('productId');
  const selectedProduct = document.getElementById('selectedProduct');
  const status = document.getElementById('form-status');

  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest && ev.target.closest('.inquire');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const name = btn.getAttribute('data-name');
    productIdInput.value = id;
    selectedProduct.textContent = name;
    // Smooth-scroll to the inquiry form using the shared helper
    try { scrollToId('inquiry-form'); } catch (e) { window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); }
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    status.textContent = 'Sending...';
    const selectedId = productIdInput.value || null;
    const selectedProductObj = selectedId ? productsCache.find(p => String(p.id) === String(selectedId)) || null : null;
    const payload = {
      name: document.getElementById('name').value.trim(),
      phone: document.getElementById('phone').value.trim(),
      email: document.getElementById('email').value.trim(),
      message: document.getElementById('message').value.trim(),
      productId: selectedId || null,
      product: selectedProductObj
    };
    try {
      const res = await fetch('/api/inquiries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const err = await res.json().catch(()=>({}));
        throw new Error(err.error || 'Server error');
      }
      const data = await res.json();
      status.textContent = 'Inquiry sent — thank you!';
      form.reset();
      productIdInput.value = '';
      selectedProduct.textContent = '(none)';
    } catch (err) {
      console.error(err);
      status.textContent = 'Failed to send inquiry. ' + (err.message || 'Please try again later.');
    }
  });
}

// Scroll to an element id with header offset and focus handling
function scrollToId(id) {
  if (!id) return;
  const target = document.getElementById(id);
  if (!target) return;
  const header = document.querySelector('.site-header');
  const offset = header ? Math.ceil(header.getBoundingClientRect().height) + 8 : 8;
  const desiredTop = Math.max(0, Math.floor(target.getBoundingClientRect().top + window.pageYOffset - offset));

  try {
    const root = document.documentElement;
    const prev = root.style.scrollPaddingTop || '';
    root.style.scrollPaddingTop = offset + 'px';

    // First try: modern browsers respect scroll-padding-top with scrollIntoView
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // After animation starts, verify and correct if necessary
    setTimeout(() => {
      const current = window.pageYOffset;
      if (Math.abs(current - desiredTop) > 6) {
        // perform an explicit scroll to the computed position
        window.scrollTo({ top: desiredTop, behavior: 'smooth' });
      }
      try { target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true }); } catch (e) { try { target.focus(); } catch (e2) {} }
      root.style.scrollPaddingTop = prev;
    }, 500);
  } catch (err) {
    // Final fallback: direct scrollTo
    window.scrollTo({ top: desiredTop, behavior: 'smooth' });
    setTimeout(() => { try { target.setAttribute('tabindex', '-1'); target.focus(); } catch (e) {} }, 500);
  }
}

function setupHeaderSmoothScroll() {
  document.addEventListener('click', (ev) => {
    // normalize the clicked element to an Element (handle text nodes)
    let node = ev.target;
    while (node && node.nodeType !== 1) node = node.parentElement;
    if (!node) return;
    const a = node.closest('.site-nav a, .header-actions a');
    if (!a) return;

    const href = a.getAttribute('href') || '';
    if (!href.startsWith('#')) return; // allow external/tel links
    const id = href.slice(1);
    if (!id) return;

    ev.preventDefault();
    // push the hash into history so back/forward works
    try { history.pushState && history.pushState(null, '', '#' + id); } catch (e) {}
    scrollToId(id);
  });

  // handle direct hash navigation (back/forward or manual changes)
  window.addEventListener('hashchange', () => {
    const id = (location.hash || '').replace(/^#/, '');
    if (id) scrollToId(id);
  });

  // on initial load, if there's a hash, scroll to it after a short delay to allow layout to settle
  if (location.hash) {
    const id = location.hash.replace(/^#/, '');
    setTimeout(() => { scrollToId(id); }, 120);
  }
}

// Utility: debounce
function debounce(fn, wait) {
  let t;
  return function(...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

// Filter products by search query (case-insensitive substring match across name/type/brand/tags)
function filterProducts(products, query) {
  if (!query) return products;
  const q = String(query).trim().toLowerCase();
  if (!q) return products;
  return products.filter(p => {
    try {
      if ((p.name || '').toString().toLowerCase().includes(q)) return true;
      if ((p.type || '').toString().toLowerCase().includes(q)) return true;
      if ((p.brand || '').toString().toLowerCase().includes(q)) return true;
      // tags may be array or comma string
      const tags = Array.isArray(p.tags) ? p.tags : (p.tags ? String(p.tags).split(',') : []);
      for (const t of tags) if ((t || '').toString().toLowerCase().includes(q)) return true;
      return false;
    } catch (e) {
      return false;
    }
  });
}

// Wire up search controls (called after products are loaded)
function setupSearchControls() {
  const searchInput = document.getElementById('search-input');
  const clearBtn = document.getElementById('search-clear');
  const groupSelect = document.getElementById('group-select');

  let currentProducts = productsCache || [];
  let currentGroup = groupSelect ? groupSelect.value : 'brand';

  function renderFromQuery() {
    const q = searchInput ? searchInput.value : '';
    const filtered = filterProducts(currentProducts, q);
    renderGrouped(filtered, currentGroup);
  }

  const debouncedRender = debounce(renderFromQuery, 220);

  if (searchInput) {
    searchInput.addEventListener('input', () => debouncedRender());
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (searchInput) searchInput.value = '';
      renderFromQuery();
    });
  }

  if (groupSelect) {
    groupSelect.addEventListener('change', () => {
      currentGroup = groupSelect.value;
      renderFromQuery();
    });
  }
}

(async function init() {
  try {
    // ensure header link handlers are active as early as possible
    setupHeaderSmoothScroll();

    const products = await fetchProducts();
    // cache products for inquiry payloads
    productsCache = products || [];
    // default grouping: brand
    renderGrouped(products, 'brand');
    setupInquiryForm();
    setupSearchControls();

    const groupSelect = document.getElementById('group-select');
    if (groupSelect) {
      groupSelect.addEventListener('change', () => {
        const mode = groupSelect.value;
        renderGrouped(products, mode);
      });
    }
  } catch (err) {
    const container = document.getElementById('products');
    container.innerHTML = '<p class="error">Failed to load products.</p>';
    console.error(err);
  }
})();
