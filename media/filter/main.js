// SSH Fleet sidebar filter — thin reflector for ServerFilterState.
// Receives `state` snapshots from the extension and posts `filterSet` /
// `filterClear` back. Lives in its own WebviewView above the Servers
// TreeView so the filter strip is always visible.

(function () {
  const vscode = acquireVsCodeApi();
  const state = {
    availableEnvs: [],
    availableModules: [],
    filterEnvs: [],
    filterModules: [],
    filterText: ''
  };

  let textDebounce = null;

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('btnEnvDd').onclick = () => toggleDd('envDd');
    document.getElementById('btnModDd').onclick = () => toggleDd('modDd');
    document.getElementById('btnFilterClear').onclick = () => {
      vscode.postMessage({ type: 'filterClear' });
    };
    const txt = document.getElementById('filterText');
    txt.addEventListener('input', (ev) => {
      // Debounced — each keystroke shouldn't churn the TreeView.
      clearTimeout(textDebounce);
      textDebounce = setTimeout(() => {
        vscode.postMessage({ type: 'filterSet', text: ev.target.value });
      }, 180);
    });

    document.addEventListener('click', (ev) => {
      // Close any open dropdown when the click lands outside it.
      for (const dd of document.querySelectorAll('.filter-dd')) {
        if (dd.classList.contains('hidden')) continue;
        if (dd.contains(ev.target)) continue;
        const wrap = dd.parentElement;
        if (wrap && wrap.contains(ev.target)) continue;
        dd.classList.add('hidden');
      }
    });

    vscode.postMessage({ type: 'ready' });
  });

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg && msg.type === 'state') {
      Object.assign(state, msg.state);
      render();
    }
  });

  function render() {
    const envBtn = document.getElementById('btnEnvDd');
    const modBtn = document.getElementById('btnModDd');
    const envLabel = document.getElementById('envDdLabel');
    const modLabel = document.getElementById('modDdLabel');

    const envSelected = state.filterEnvs ?? [];
    const modSelected = state.filterModules ?? [];
    envLabel.textContent = envSelected.length === 0 ? 'Envs' : `Envs (${envSelected.length})`;
    modLabel.textContent = modSelected.length === 0 ? 'Modules' : `Modules (${modSelected.length})`;
    envBtn.classList.toggle('has-selection', envSelected.length > 0);
    modBtn.classList.toggle('has-selection', modSelected.length > 0);

    const txt = document.getElementById('filterText');
    if (document.activeElement !== txt && txt.value !== (state.filterText ?? '')) {
      txt.value = state.filterText ?? '';
    }

    renderDd('envDd', state.availableEnvs ?? [], new Set(envSelected), '(no env metadata)', (next) => {
      vscode.postMessage({ type: 'filterSet', envs: [...next] });
    });
    renderDd('modDd', state.availableModules ?? [], new Set(modSelected), '(no module metadata)', (next) => {
      vscode.postMessage({ type: 'filterSet', modules: [...next] });
    });
  }

  function renderDd(id, all, selected, emptyText, onChange) {
    const dd = document.getElementById(id);
    while (dd.firstChild) dd.removeChild(dd.firstChild);
    if (all.length === 0) {
      const e = document.createElement('div');
      e.className = 'filter-dd-empty';
      e.textContent = emptyText;
      dd.appendChild(e);
      return;
    }
    for (const v of all) {
      const lbl = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selected.has(v);
      cb.onchange = () => {
        const next = new Set(selected);
        if (cb.checked) next.add(v); else next.delete(v);
        onChange(next);
      };
      lbl.appendChild(cb);
      const span = document.createElement('span');
      span.textContent = v;
      lbl.appendChild(span);
      dd.appendChild(lbl);
    }
  }

  function toggleDd(id) {
    const dd = document.getElementById(id);
    for (const other of document.querySelectorAll('.filter-dd')) {
      if (other.id !== id) other.classList.add('hidden');
    }
    dd.classList.toggle('hidden');
  }
})();
