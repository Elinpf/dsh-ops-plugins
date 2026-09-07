/**
 * The hub's built-in web UI: a single static HTML page with inline vanilla
 * JS/CSS — no build chain, no external CDN. Served at `GET /` without auth;
 * the page itself prompts for a Bearer token (kept in localStorage) and all
 * data fetches carry it, so no secret material is embedded in the HTML.
 *
 * UI copy is Chinese per repo convention for operator-facing surfaces.
 * NOTE: this string must not contain backticks or `${` sequences — the
 * inline JS uses string concatenation instead of template literals.
 *
 * @module
 */

export const WEB_UI_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-ops-access-hub</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #0f1419; color: #d8dee6; }
  header { display: flex; gap: 8px; align-items: center; padding: 12px 16px; background: #161d26; border-bottom: 1px solid #2a3441; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0 12px 0 0; }
  input, select, textarea, button { font: inherit; border-radius: 4px; border: 1px solid #3a4655; background: #0f1419; color: inherit; padding: 6px 8px; }
  button { cursor: pointer; background: #1f2937; }
  button:hover { background: #2a3646; }
  button.danger { border-color: #7f2d2d; color: #f0a0a0; }
  main { padding: 16px; max-width: 1100px; margin: 0 auto; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #2a3441; vertical-align: top; }
  th { color: #8b98a9; font-weight: 600; font-size: 13px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; margin-right: 4px; border: 1px solid #3a4655; }
  .badge.verified { border-color: #2f7d4f; color: #7fd6a4; }
  .badge.mismatch { border-color: #a33; color: #f0a0a0; }
  .badge.unverifiable { border-color: #8a6d1d; color: #e6c96a; }
  .muted { color: #8b98a9; }
  #msg { margin: 8px 0; min-height: 20px; color: #f0a0a0; white-space: pre-wrap; }
  #msg.ok { color: #7fd6a4; }
  dialog { background: #161d26; color: inherit; border: 1px solid #3a4655; border-radius: 8px; padding: 16px; width: min(640px, 92vw); }
  dialog label { display: block; margin: 8px 0 2px; font-size: 13px; color: #8b98a9; }
  dialog input, dialog select, dialog textarea { width: 100%; }
  dialog textarea { min-height: 160px; font-family: ui-monospace, monospace; font-size: 13px; }
  .row { display: flex; gap: 8px; }
  .row > div { flex: 1; }
  section { margin-top: 24px; }
  h2 { font-size: 15px; }
</style>
</head>
<body>
<header>
  <h1>dsh-ops-access-hub</h1>
  <input id="token" type="password" placeholder="Bearer token" size="36">
  <button id="saveToken">保存 token</button>
  <button id="refresh">刷新</button>
  <button id="newEntry">新建条目</button>
  <button id="showAudit">审计记录</button>
  <span id="whoami" class="muted"></span>
</header>
<main>
  <div id="msg"></div>
  <section>
    <h2>条目</h2>
    <table>
      <thead><tr><th>kind / name</th><th>显示名</th><th>描述</th><th>环境</th><th>tier</th><th>更新时间</th><th>操作</th></tr></thead>
      <tbody id="entries"></tbody>
    </table>
  </section>
  <section id="auditSection" style="display:none">
    <h2>审计记录(最近 100 条)</h2>
    <table>
      <thead><tr><th>时间</th><th>角色</th><th>动作</th><th>条目</th><th>tier</th></tr></thead>
      <tbody id="audit"></tbody>
    </table>
  </section>
</main>
<dialog id="editor">
  <h2 id="editorTitle">编辑条目</h2>
  <div class="row">
    <div><label>kind</label><input id="fKind" placeholder="k8s"></div>
    <div><label>profile 名</label><input id="fName" placeholder="prod"></div>
    <div><label>tier</label><select id="fTier"><option value="ro">ro</option><option value="rw">rw</option></select></div>
  </div>
  <div class="row">
    <div><label>显示名(envelope.name)</label><input id="fDisp"></div>
    <div><label>环境(envelope.environment)</label><input id="fEnv"></div>
  </div>
  <label>描述(envelope.description)</label><input id="fDesc">
  <label>字段(JSON object,值为字段内容)</label>
  <textarea id="fFields" spellcheck="false"></textarea>
  <div id="formErr" style="color:#f0a0a0;min-height:18px;margin-top:4px"></div>
  <div style="margin-top:12px;text-align:right">
    <button id="cancelEdit">取消</button>
    <button id="saveEntry">保存</button>
  </div>
</dialog>
<script>
(function () {
  var token = localStorage.getItem('hubToken') || '';
  var tokenInput = document.getElementById('token');
  tokenInput.value = token;
  var msg = document.getElementById('msg');
  var entriesBody = document.getElementById('entries');
  var auditSection = document.getElementById('auditSection');
  var auditBody = document.getElementById('audit');
  var editor = document.getElementById('editor');
  var formErr = document.getElementById('formErr');
  var entriesCache = [];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function say(text, ok) {
    msg.textContent = text || '';
    msg.className = ok ? 'ok' : '';
  }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = { 'Authorization': 'Bearer ' + token };
    if (opts.body) opts.headers['Content-Type'] = 'application/json';
    return fetch(path, opts).then(function (res) {
      return res.json().then(function (body) { return { status: res.status, body: body }; });
    });
  }
  function probeBadge(tierInfo) {
    if (!tierInfo) return '';
    var p = tierInfo.probe;
    if (!p) return '<span class="badge">无 probe</span>';
    return '<span class="badge ' + esc(p.status) + '" title="' + esc(p.detail || '') + ' ' + esc(p.probedAt) + '">' + esc(p.status) + '</span>';
  }
  function tierCell(e, tier) {
    var info = e.tiers && e.tiers[tier];
    if (!info) return '<span class="muted">' + tier + ': —</span><br>';
    return tier + ': ' + probeBadge(info) +
      ' <button data-edit="' + esc(e.kind) + '|' + esc(e.name) + '|' + tier + '">编辑</button>' +
      ' <button class="danger" data-del="' + esc(e.kind) + '|' + esc(e.name) + '|' + tier + '">删除</button><br>';
  }
  function render() {
    entriesBody.innerHTML = entriesCache.map(function (e) {
      var env = e.envelope || {};
      return '<tr><td><b>' + esc(e.kind) + '</b> / ' + esc(e.name) + '</td><td>' + esc(env.name || '') +
        '</td><td>' + esc(env.description || '') + '</td><td>' + esc(env.environment || '') +
        '</td><td>' + tierCell(e, 'ro') + tierCell(e, 'rw') +
        '</td><td class="muted">' + esc(e.updatedAt || '') + '</td><td></td></tr>';
    }).join('') || '<tr><td colspan="7" class="muted">(空)</td></tr>';
  }
  function load() {
    api('/entries').then(function (r) {
      if (r.status !== 200) { say('加载失败:' + (r.body && r.body.error || r.status)); return; }
      entriesCache = r.body;
      render();
      say('');
    }).catch(function (err) { say('请求失败:' + err.message); });
  }
  document.getElementById('saveToken').onclick = function () {
    token = tokenInput.value.trim();
    localStorage.setItem('hubToken', token);
    say('token 已保存', true);
    load();
  };
  document.getElementById('refresh').onclick = load;
  entriesBody.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    var edit = t.getAttribute('data-edit');
    var del = t.getAttribute('data-del');
    if (edit) { var p = edit.split('|'); openEditor(p[0], p[1], p[2]); }
    if (del) {
      var q = del.split('|');
      if (!confirm('确认删除 ' + q[0] + '/' + q[1] + ' 的 ' + q[2] + ' tier?')) return;
      api('/entries/' + encodeURIComponent(q[0]) + '/' + encodeURIComponent(q[1]) + '/' + q[2], { method: 'DELETE' })
        .then(function (r) {
          if (r.status !== 200) { say('删除失败:' + (r.body && r.body.error || r.status)); return; }
          say('已删除', true); load();
        });
    }
  });
  function openEditor(kind, name, tier) {
    document.getElementById('fKind').value = kind || '';
    document.getElementById('fName').value = name || '';
    document.getElementById('fTier').value = tier || 'ro';
    document.getElementById('fKind').disabled = !!kind;
    document.getElementById('fName').disabled = !!name;
    document.getElementById('fTier').disabled = !!tier;
    formErr.textContent = '';
    var env = {};
    for (var i = 0; i < entriesCache.length; i++) {
      if (entriesCache[i].kind === kind && entriesCache[i].name === name) env = entriesCache[i].envelope || {};
    }
    document.getElementById('fDisp').value = env.name || '';
    document.getElementById('fDesc').value = env.description || '';
    document.getElementById('fEnv').value = env.environment || '';
    var fieldsBox = document.getElementById('fFields');
    fieldsBox.value = '{}';
    if (kind && name && tier) {
      api('/entries/' + encodeURIComponent(kind) + '/' + encodeURIComponent(name) + '/' + tier).then(function (r) {
        if (r.status === 200) fieldsBox.value = JSON.stringify(r.body.fields || {}, null, 2);
      });
    }
    editor.showModal();
  }
  document.getElementById('newEntry').onclick = function () { openEditor('', '', ''); };
  document.getElementById('cancelEdit').onclick = function () { editor.close(); };
  document.getElementById('saveEntry').onclick = function () {
    var kind = document.getElementById('fKind').value.trim();
    var name = document.getElementById('fName').value.trim();
    var tier = document.getElementById('fTier').value;
    var fields;
    try { fields = JSON.parse(document.getElementById('fFields').value); }
    catch (err) { formErr.textContent = '字段 JSON 解析失败:' + err.message; return; }
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) { formErr.textContent = '字段必须是 JSON object'; return; }
    var envelope = {};
    var disp = document.getElementById('fDisp').value.trim();
    var desc = document.getElementById('fDesc').value.trim();
    var envv = document.getElementById('fEnv').value.trim();
    if (disp) envelope.name = disp;
    if (desc) envelope.description = desc;
    if (envv) envelope.environment = envv;
    api('/entries/' + encodeURIComponent(kind) + '/' + encodeURIComponent(name) + '/' + tier, {
      method: 'PUT',
      body: JSON.stringify({ fields: fields, envelope: envelope }),
    }).then(function (r) {
      if (r.status !== 200) { formErr.textContent = '保存失败:' + (r.body && r.body.error || r.status); return; }
      editor.close(); say('已保存', true); load();
    });
  };
  document.getElementById('showAudit').onclick = function () {
    auditSection.style.display = auditSection.style.display === 'none' ? '' : 'none';
    if (auditSection.style.display === 'none') return;
    api('/audit?limit=100').then(function (r) {
      if (r.status !== 200) { say('审计加载失败:' + (r.body && r.body.error || r.status)); return; }
      auditBody.innerHTML = r.body.map(function (a) {
        return '<tr><td class="muted">' + esc(a.ts) + '</td><td>' + esc(a.role) + '</td><td>' + esc(a.action) +
          '</td><td>' + esc(a.kind) + ' / ' + esc(a.name) + '</td><td>' + esc(a.tier) + '</td></tr>';
      }).join('') || '<tr><td colspan="5" class="muted">(空)</td></tr>';
    });
  };
  load();
})();
</script>
</body>
</html>
`
