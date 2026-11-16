// Token Radar dashboard: renders window.RADAR (written by main.ts) as a
// sortable, filterable board with a detail view per protocol. No network:
// the only data source is ../data.js, loaded before this file.
(function () {
  'use strict';
  var R = window.RADAR;
  var app = document.getElementById('app');
  var foot = document.getElementById('foot');
  if (!R || !Array.isArray(R.rows)) {
    app.innerHTML = '<div class="card"><h2>No data</h2><p>data.js did not load. Rebuild the entry with main.ts.</p></div>';
    app.setAttribute('aria-busy', 'false');
    return;
  }

  var state = { q: '', status: 'watchlist', category: 'all', sort: 'rank', dir: 1, selected: null };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    if (n == null) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function moneyFull(n) {
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function pct(x) {
    if (x == null) return '—';
    var s = (x >= 0 ? '+' : '') + x.toFixed(2) + '%';
    return s;
  }
  function ageText(days) {
    if (days == null) return '—';
    if (days < 30) return days + 'd';
    if (days < 365) return Math.round(days / 30) + 'mo';
    return (days / 365).toFixed(1) + 'y';
  }

  var SORTS = {
    rank: function (a, b) { return a.rank - b.rank; },
    implied: function (a, b) { return b.implied_value_usd - a.implied_value_usd; },
    tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
    change: function (a, b) { return (b.change_7d == null ? -999 : b.change_7d) - (a.change_7d == null ? -999 : a.change_7d); },
    age: function (a, b) { return (b.age_days == null ? -1 : b.age_days) - (a.age_days == null ? -1 : a.age_days); },
  };

  function readHash() {
    var h = (location.hash || '').replace(/^#/, '');
    var parts = h.split('&');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');
      if (kv.length !== 2) continue;
      var k = decodeURIComponent(kv[0]);
      var v = decodeURIComponent(kv[1]);
      if (k === 'protocol') state.selected = v || null;
      if (k === 'status' && (v === 'watchlist' || v === 'pre-token' || v === 'live' || v === 'all')) state.status = v;
      if (k === 'category') state.category = v || 'all';
      if (k === 'sort' && SORTS[v]) state.sort = v;
    }
  }

  function writeHash() {
    var bits = [];
    if (state.selected) bits.push('protocol=' + encodeURIComponent(state.selected));
    if (state.status !== 'watchlist') bits.push('status=' + state.status);
    if (state.category !== 'all') bits.push('category=' + encodeURIComponent(state.category));
    if (state.sort !== 'rank') bits.push('sort=' + state.sort);
    var next = bits.length ? '#' + bits.join('&') : '#';
    if (location.hash !== next) history.replaceState(null, '', next);
  }

  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    var rows = R.rows.filter(function (r) {
      if (state.status === 'watchlist' && !r.watchlist) return false;
      if (state.status === 'pre-token' && r.status !== 'pre-token') return false;
      if (state.status === 'live' && r.status !== 'token live') return false;
      if (state.category !== 'all' && (r.category || 'Uncategorised') !== state.category) return false;
      if (q && (r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0)) return false;
      return true;
    });
    var fn = SORTS[state.sort] || SORTS.rank;
    rows.sort(function (a, b) {
      var d = fn(a, b);
      return state.sort === 'rank' ? d : d * state.dir;
    });
    return rows;
  }

  function pill(r) {
    return r.status === 'pre-token'
      ? '<span class="pill pre">Pre-token</span>'
      : '<span class="pill live">Token live</span>';
  }

  function modelCard() {
    var m = R.meta;
    return '<section class="card"><h2>How the value is computed</h2>' +
      '<p><span class="model-line">implied = TVL × ' + m.base_multiple.toFixed(3) + ' × growth × age</span></p>' +
      '<p>' + esc(R.model_note) + '</p>' +
      '<div class="stats">' +
      '<div class="stat"><b>' + m.rows + '</b><span>protocols ranked</span></div>' +
      '<div class="stat"><b>' + m.watchlist_rows + '</b><span>watchlist covered</span></div>' +
      '<div class="stat"><b>' + m.other_rows + '</b><span>other, no token recorded</span></div>' +
      '<div class="stat"><b>' + m.live_rows + '</b><span>live comparisons</span></div>' +
      '<div class="stat"><b>' + m.base_multiple.toFixed(3) + '</b><span>market multiple (median mcap/TVL, n=' + m.live_count + ')</span></div>' +
      '<div class="stat"><b>' + m.multiple_q25.toFixed(3) + '–' + m.multiple_q75.toFixed(3) + '</b><span>peer multiple, interquartile range</span></div>' +
      '</div><p style="margin-top:10px">' + m.unranked + ' protocols record a token but no usable market cap and are not ranked.</p></section>';
  }

  function controls() {
    var cats = {};
    R.rows.forEach(function (r) { cats[r.category || 'Uncategorised'] = true; });
    var opts = ['<option value="all">All categories</option>'];
    Object.keys(cats).sort().forEach(function (c) {
      opts.push('<option value="' + esc(c) + '"' + (state.category === c ? ' selected' : '') + '>' + esc(c) + '</option>');
    });
    return '<div class="controls">' +
      '<input type="search" id="q" placeholder="Search name or slug…" value="' + esc(state.q) + '" aria-label="Search">' +
      '<label>Status <select id="f-status">' +
      '<option value="watchlist"' + (state.status === 'watchlist' ? ' selected' : '') + '>Watchlist (40)</option>' +
      '<option value="all"' + (state.status === 'all' ? ' selected' : '') + '>All</option>' +
      '<option value="pre-token"' + (state.status === 'pre-token' ? ' selected' : '') + '>Pre-token</option>' +
      '<option value="live"' + (state.status === 'live' ? ' selected' : '') + '>Token live</option>' +
      '</select></label>' +
      '<label>Category <select id="f-cat">' + opts.join('') + '</select></label>' +
      '<span class="count" id="count"></span>' +
      '</div>';
  }

  function table(rows) {
    function th(key, label, cls) {
      var mark = state.sort === key ? (state.dir === 1 ? ' ▲' : ' ▼') : '';
      return '<th data-sort="' + key + '" class="' + (cls || '') + (state.sort === key ? ' sorted' : '') + '">' + label + mark + '</th>';
    }
    var html = '<div class="card" style="padding:0;overflow-x:auto"><table><thead><tr>' +
      th('rank', '#') + '<th>Protocol</th>' + th('tvl', 'TVL', 'num') + th('change', '7d', 'num') +
      th('age', 'Age', 'num') + th('implied', 'Implied value', 'num') + '<th>Status</th>' +
      '</tr></thead><tbody>';
    if (!rows.length) {
      html += '<tr><td colspan="7"><div class="empty">No protocols match this filter.</div></td></tr>';
    }
    rows.forEach(function (r) {
      var chg = r.change_7d == null ? '<span>—</span>' : '<span class="' + (r.change_7d >= 0 ? 'up' : 'down') + '">' + pct(r.change_7d) + '</span>';
      html += '<tr data-slug="' + esc(r.slug) + '"' + (state.selected === r.slug ? ' class="selected"' : '') + '>' +
        '<td class="num">' + r.rank + '</td>' +
        '<td class="name"><b>' + esc(r.name) + '</b><span>' + esc(r.slug) + ' · ' + esc(r.category || 'Uncategorised') + '</span></td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + chg + '</td>' +
        '<td class="num">' + ageText(r.age_days) + '</td>' +
        '<td class="num"><strong>' + money(r.implied_value_usd) + '</strong></td>' +
        '<td>' + pill(r) + '</td></tr>';
    });
    return html + '</tbody></table></div>';
  }

  function detail(slug) {
    var r = null;
    for (var i = 0; i < R.rows.length; i++) if (R.rows[i].slug === slug) { r = R.rows[i]; break; }
    if (!r) return '';
    var steps = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    var mcap = r.mcap_usd != null
      ? '<div><b>' + moneyFull(r.mcap_usd) + '</b><span>actual market cap</span></div>' +
        '<div><b>' + (r.actual_over_modeled == null ? '—' : r.actual_over_modeled.toFixed(2) + '×') + '</b><span>actual / modelled value</span></div>'
      : '<div><b>No token recorded</b><span>DefiLlama lists no gecko_id or symbol — that is what the record says, not proof it has none</span></div>';
    var flags = [];
    if (r.change_7d == null) flags.push('7-day change missing — median week used');
    if (r.listed_at == null) flags.push('listing date missing — age imputed from the no-token median');
    if (r.age_imputed) flags.push('age is imputed, not read');
    var flagLine = flags.length ? '<p style="color:var(--amber)">Flags: ' + esc(flags.join('; ')) + '.</p>' : '';
    var exclLine = r.watchlist
      ? '<p>On the watchlist: TVL at or above the $50M floor, no token recorded, and not a wrapped, staked or bridged product.</p>'
      : '<p>Outside the watchlist: ' + esc(r.exclusion || 'no reason recorded') + '.</p>';
    return '<section class="detail" id="detail"><button class="back" id="back">← Back to the board</button>' +
      '<h2>' + esc(r.name) + ' ' + pill(r) + '</h2>' +
      '<p class="meta">Rank #' + r.rank + ' · ' + esc(r.slug) + ' · ' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.join(', ')) + ' · first tracked ' + (r.listed_at == null ? 'unknown' : esc(r.listed_at)) + ' · listed age ' + (r.age_days == null ? '—' : ageText(r.age_days)) + (r.age_imputed ? ' (imputed)' : '') + '</p>' +
      '<div class="kv">' +
      '<div><b>' + moneyFull(r.implied_value_usd) + '</b><span>implied value</span></div>' +
      '<div><b>' + moneyFull(r.tvl_usd) + '</b><span>TVL (snapshot figure)</span></div>' +
      '<div><b>' + pct(r.change_7d) + '</b><span>TVL change, 7 days (snapshot figure)</span></div>' +
      mcap +
      '</div>' +
      '<div class="breakdown">implied = ' + moneyFull(r.tvl_usd) + ' × ' + r.multiple.toFixed(4) + ' (market multiple) × ' + r.growth_factor.toFixed(3) + ' (growth) × ' + r.age_factor.toFixed(3) + ' (age) = ' + moneyFull(r.implied_value_usd) + '</div>' +
      '<p>Multiple: median market-cap-per-TVL of ' + R.meta.live_count + ' live protocols (interquartile range ' + R.meta.multiple_q25.toFixed(3) + '–' + R.meta.multiple_q75.toFixed(3) + '). Growth compares this week’s change with the snapshot median week (' + R.meta.g50.toFixed(2) + 'pp). Age is listed age — time since DefiLlama began tracking — not verified operating age. Coefficients 0.25, 0.8 and 0.4 are design assumptions, not estimated relationships.</p>' +
      exclLine +
      flagLine +
      '<h3 style="margin:14px 0 4px">How to farm it</h3>' +
      '<ol class="steps">' + steps + '</ol></section>';
  }

  function render() {
    var rows = visibleRows();
    // When a protocol is selected, its detail leads so the detail view reads
    // on its own; otherwise the model card and controls lead.
    var html = state.selected ? detail(state.selected) + modelCard() + controls() : modelCard() + controls();
    html += table(rows);
    app.innerHTML = html;
    app.setAttribute('aria-busy', 'false');
    var count = document.getElementById('count');
    if (count) count.textContent = rows.length + ' of ' + R.rows.length + ' shown';
    var q = document.getElementById('q');
    if (q) {
      q.addEventListener('input', function () { state.q = q.value; render(); var nq = document.getElementById('q'); if (nq) { nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length); } });
    }
    var fs = document.getElementById('f-status');
    if (fs) fs.addEventListener('change', function () { state.status = fs.value; state.selected = null; writeHash(); render(); });
    var fc = document.getElementById('f-cat');
    if (fc) fc.addEventListener('change', function () { state.category = fc.value; state.selected = null; writeHash(); render(); });
    var heads = app.querySelectorAll('th[data-sort]');
    for (var i = 0; i < heads.length; i++) {
      heads[i].addEventListener('click', function () {
        var key = this.getAttribute('data-sort');
        if (state.sort === key) { state.dir = -state.dir; } else { state.sort = key; state.dir = key === 'rank' ? 1 : 1; }
        writeHash(); render();
      });
    }
    var trs = app.querySelectorAll('tbody tr[data-slug]');
    for (var j = 0; j < trs.length; j++) {
      trs[j].addEventListener('click', function () {
        state.selected = this.getAttribute('data-slug');
        writeHash(); render();
        var d = document.getElementById('detail');
        if (d) d.scrollIntoView({ block: 'start' });
      });
    }
    var back = document.getElementById('back');
    if (back) back.addEventListener('click', function () { state.selected = null; writeHash(); render(); });
  }

  foot.innerHTML = '<p>Data: DefiLlama public API, snapshot as of ' + esc(R.meta.as_of) + ' · watchlist floor $' + R.meta.floor_usd.toLocaleString('en-US') + ' TVL. Implied values are this entry’s own claim from the snapshot’s figures, never a prediction of whether or when a token is issued.</p>' +
    '<p>Model ' + esc(R.meta.model_version) + ': ' + esc(R.meta.model) + '. “Records no token” means DefiLlama lists no token for the protocol; it is not proof none exists.</p>';

  readHash();
  render();
  window.addEventListener('hashchange', function () { readHash(); render(); });
})();
