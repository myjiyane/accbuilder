// public/widget/wb-passport.js
// Minimal, framework-free buyer widget. Call WBPassport.render('#el', { vin, baseUrl? }).

export const WBPassport = {
  async render(target, opts) {
    const root =
      typeof target === "string" ? document.querySelector(target) : target;
    if (!root) throw new Error("WBPassport: target not found");

    const vin = opts?.vin;
    const base = (opts?.baseUrl || "").replace(/\/+$/, ""); // same-origin by default
    if (!vin) {
      root.innerHTML = `<div class="wbp wbp-card"><p>VIN is required.</p></div>`;
      return;
    }

    // inject minimal styles once
    ensureStyles();

    root.innerHTML = `<div class="wbp wbp-card"><div class="wbp-header">Loading…</div></div>`;

    try {
      const rec = await fetchJSON(`${base}/passports/${encodeURIComponent(vin)}`);
      const model = rec.sealed || rec.draft;
      if (!model) {
        root.innerHTML = card(`
          <div class="wbp-header">
            <span class="wbp-title">WesBank Digital Vehicle Passport</span>
            <span class="wbp-badge wbp-badge--red">Missing</span>
          </div>
          <div class="wbp-body"><p>No passport found for VIN <code>${vin}</code>.</p></div>
        `);
        return;
      }

      // Render fields
      const sealed = !!rec.sealed;
      const dekraOk = !!model?.dekra?.inspection_ts;
      const km = model?.odometer?.km ?? "—";
      const tyres = model?.tyres_mm || {};
      const dtc = model?.dtc || { status: "n/a", codes: [] };

      const dtcBadge = statusBadge(dtc.status);
      const sealBadge = sealed
        ? `<span class="wbp-badge wbp-badge--green">Sealed ✓</span>`
        : `<span class="wbp-badge wbp-badge--amber">Draft</span>`;
      const dekraBadge = dekraOk
        ? `<span class="wbp-badge">DEKRA ✓</span>`
        : `<span class="wbp-badge wbp-badge--muted">DEKRA —</span>`;

      const sealedTs = sealed ? escapeHtml(rec.sealed.seal.sealed_ts) : "";
      const ctaDisabledAttr = sealed ? "" : "disabled";
      const ctaTitle = sealed ? "Place bid" : "Passport must be sealed";

      root.innerHTML = card(`
        <div class="wbp-header">
          <span class="wbp-title">WesBank Digital Vehicle Passport</span>
          <span class="wbp-pillrow">${sealBadge}${dekraBadge}</span>
        </div>

        <div class="wbp-body">
          <div class="wbp-kv">
            <div><span class="wbp-label">VIN</span><span class="wbp-val">${escapeHtml(
              model.vin
            )}</span></div>
            <div><span class="wbp-label">Odometer</span><span class="wbp-val">${fmtKm(
              km
            )}</span></div>
            <div><span class="wbp-label">Inspection</span><span class="wbp-val">${fmtDate(
              model?.dekra?.inspection_ts
            )}</span></div>
            <div><span class="wbp-label">Site</span><span class="wbp-val">${escapeHtml(
              model?.dekra?.site || "—"
            )}</span></div>
            ${
              sealed
                ? `<div><span class="wbp-label">Sealed</span><span class="wbp-val">${escapeHtml(
                    sealedTs
                  )}</span></div>`
                : ""
            }
          </div>

          <div class="wbp-section">
            <div class="wbp-section-title">Tyres (mm)</div>
            <div class="wbp-tyres">
              ${tyreCell("FL", tyres.fl)}${tyreCell("FR", tyres.fr)}
              ${tyreCell("RL", tyres.rl)}${tyreCell("RR", tyres.rr)}
            </div>
          </div>

          <div class="wbp-section">
            <div class="wbp-section-title">Diagnostics</div>
            <div class="wbp-dtc">${dtcBadge}
              ${
                (dtc.codes || []).slice(0, 4).map(c => `<code>${escapeHtml(c.code)}</code>`).join(" ")
              }
            </div>
          </div>
        </div>

        <div class="wbp-footer">
          <button class="wbp-btn" ${ctaDisabledAttr} title="${ctaTitle}">Bid now</button>
          <button class="wbp-btn wbp-btn--ghost" data-verify>Verify</button>
          <span class="wbp-verify" data-verify-out></span>
        </div>
      `);

      // Wire verify button
      const verifyBtn = root.querySelector("[data-verify]");
      const verifyOut = root.querySelector("[data-verify-out]");
      if (verifyBtn && verifyOut) {
        verifyBtn.addEventListener("click", async () => {
          verifyBtn.disabled = true;
          verifyOut.textContent = "Verifying…";
          try {
            const res = await fetchJSON(`${base}/verify?vin=${encodeURIComponent(vin)}`);
            verifyOut.textContent = res.valid ? "Signature valid ✓" : `Invalid ✕ (${(res.reasons||[]).join(", ")})`;
            verifyOut.className = "wbp-verify " + (res.valid ? "wbp-ok" : "wbp-bad");
          } catch (e) {
            verifyOut.textContent = "Error verifying";
            verifyOut.className = "wbp-verify wbp-bad";
          } finally {
            verifyBtn.disabled = false;
          }
        });
      }
    } catch (e) {
      root.innerHTML = card(`
        <div class="wbp-header">
          <span class="wbp-title">WesBank Digital Vehicle Passport</span>
          <span class="wbp-badge wbp-badge--red">Error</span>
        </div>
        <div class="wbp-body"><p>Could not load passport for VIN <code>${vin}</code>.</p></div>
      `);
    }
  },
};

// Helpers
function ensureStyles() {
  if (document.getElementById("wbp-styles")) return;
  const s = document.createElement("style");
  s.id = "wbp-styles";
  s.textContent = `
  .wbp-card{font-family:Inter,system-ui,Segoe UI,Roboto,Ubuntu,Cantarell,'Helvetica Neue',Arial,sans-serif;
    max-width:740px;border:1px solid #e6eaef;border-radius:16px;padding:16px;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.04)}
  .wbp-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
  .wbp-title{font-weight:600;font-size:16px;color:#0b3b3c} /* WesBank-ish deep teal */
  .wbp-pillrow>span{margin-left:6px}
  .wbp-badge{display:inline-block;border:1px solid #b9d6d3;color:#0b3b3c;background:#e7f4f3;padding:2px 8px;border-radius:999px;font-size:12px}
  .wbp-badge--green{border-color:#b7e2c3;background:#eaf8ee;color:#0a3a22}
  .wbp-badge--amber{border-color:#f3d39a;background:#fff6e5;color:#6b4a00}
  .wbp-badge--red{border-color:#f5b0b0;background:#fdecec;color:#7a2020}
  .wbp-badge--muted{opacity:.7}
  .wbp-body{display:grid;gap:12px}
  .wbp-kv{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
  .wbp-label{display:block;font-size:12px;color:#5f6b76}
  .wbp-val{font-size:14px;color:#0f1720}
  .wbp-section{margin-top:6px}
  .wbp-section-title{font-size:13px;font-weight:600;color:#0b3b3c;margin-bottom:6px}
  .wbp-tyres{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
  .wbp-tyre{border:1px dashed #dbe3ea;border-radius:10px;padding:8px;text-align:center}
  .wbp-tyre .pos{font-size:12px;color:#5f6b76}
  .wbp-tyre .mm{font-weight:600}
  .wbp-tyre.bad{background:#fff0f0;border-color:#f5b0b0}
  .wbp-tyre.warn{background:#fff9e8;border-color:#f3d39a}
  .wbp-dtc code{margin-left:6px}
  .wbp-footer{display:flex;align-items:center;gap:10px;margin-top:10px}
  .wbp-btn{border-radius:999px;border:1px solid #0b9688;background:#11b5a3;color:#fff;padding:8px 14px;font-weight:600;cursor:pointer}
  .wbp-btn[disabled]{opacity:.5;cursor:not-allowed;background:#cfe7e4;border-color:#b9d6d3;color:#0b3b3c}
  .wbp-btn--ghost{background:transparent;color:#0b3b3c;border-color:#cbd5df}
  .wbp-verify{font-size:12px;color:#5f6b76}
  .wbp-verify.wbp-ok{color:#0a3a22}
  .wbp-verify.wbp-bad{color:#7a2020}
  `;
  document.head.appendChild(s);
}
function card(inner) { return `<div class="wbp wbp-card">${inner}</div>`; }
function fetchJSON(url){ return fetch(url).then(r => { if(!r.ok) throw new Error(r.statusText); return r.json(); }); }
function fmtKm(km){ if(km==null||km==='—') return '—'; return Intl.NumberFormat().format(km)+' km'; }
function fmtDate(iso){ if(!iso) return '—'; try{ return new Date(iso).toLocaleDateString(); }catch{return '—';} }
function tyreCell(pos, mm){
  const val = (mm==null) ? '—' : String(mm);
  const n = Number(mm);
  const cls = (isFinite(n) ? (n <= 2 ? 'bad' : (n <= 4 ? 'warn' : '')) : '');
  return `<div class="wbp-tyre ${cls}"><div class="pos">${pos}</div><div class="mm">${escapeHtml(val)}</div></div>`;
}
function statusBadge(status){
  const map = { green:['OK','wbp-badge--green'], amber:['Advisory','wbp-badge--amber'], red:['Critical','wbp-badge--red'], 'n/a':['N/A',''] };
  const [label, cls] = map[status] || ['N/A',''];
  return `<span class="wbp-badge ${cls}">${label}</span>`;
}
function escapeHtml(s){ return (s??'').toString().replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
