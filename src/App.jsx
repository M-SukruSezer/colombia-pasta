import { useState, useCallback } from "react";
import { supabase } from "./supabase.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function daysUntilExpiry(expiresAt) {
  if (!expiresAt) return null;
  return (new Date(expiresAt) - new Date()) / (1000 * 60 * 60 * 24);
}
function getUrgencyClass(days) {
  if (days === null) return "";
  if (days < 0) return "expired";
  if (days <= 1) return "critical";
  if (days <= 2) return "warning";
  return "ok";
}
function formatDate(dt) {
  if (!dt) return "—";
  return new Date(dt).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function formatDateOnly(dt) {
  if (!dt) return "—";
  return new Date(dt).toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

const STATUS_LABELS = {
  frozen:      { label: "❄️ Donuk Depo",  color: "#4fc3f7" },
  thawing:     { label: "🌡️ Çözünme",     color: "#ffb74d" },
  food_fridge: { label: "🧁 Food Dolabı", color: "#81c784" },
  sold_out:    { label: "✅ Satıldı",     color: "#a5d6a7" },
  discarded:   { label: "🗑️ İmha",        color: "#ef9a9a" },
};

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [session, setSession]           = useState(null);
  const [loading, setLoading]           = useState(false);
  const [page, setPage]                 = useState("dashboard");
  const [loginForm, setLoginForm]       = useState({ username: "", password: "" });
  const [loginError, setLoginError]     = useState("");
  const [stores, setStores]             = useState([]);
  const [cakeTypes, setCakeTypes]       = useState([]);
  const [batches, setBatches]           = useState([]);
  const [users, setUsers]               = useState([]);
  const [logs, setLogs]                 = useState([]);
  const [storeFilter, setStoreFilter]   = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [modal, setModal]               = useState(null);

  const loadData = useCallback(async (user) => {
    setLoading(true);
    try {
      const [s, ct, b, u, ml] = await Promise.all([
        supabase("stores?order=name"),
        supabase("cake_types?order=name&is_active=eq.true"),
        supabase("inventory_batches?order=created_at.desc&select=*,cake_types(*),stores(*)"),
        user?.role === "super_admin"
          ? supabase("app_users?order=created_at.desc&select=*,stores(name)")
          : Promise.resolve([]),
        supabase("movement_log?order=performed_at.desc&limit=200&select=*,app_users(full_name),stores(name),inventory_batches(batch_label)"),
      ]);
      setStores(s || []);
      setCakeTypes(ct || []);
      const allB = b || [];
      setBatches(user?.role === "super_admin" ? allB : allB.filter(x => x.store_id === user?.store_id));
      setUsers(u || []);
      const allL = ml || [];
      setLogs(user?.role === "super_admin" ? allL : allL.filter(x => x.store_id === user?.store_id));
    } catch (e) {
      console.error("Veri yükleme hatası:", e);
    }
    setLoading(false);
  }, []);

  const doLogin = async () => {
    setLoginError("");
    if (!loginForm.username || !loginForm.password) {
      setLoginError("Kullanıcı adı ve şifre gerekli.");
      return;
    }
    setLoading(true);
    try {
      const result = await supabase(
        `app_users?username=eq.${encodeURIComponent(loginForm.username)}&is_active=eq.true&select=*,stores(*)`
      );
      if (!result || result.length === 0) {
        setLoginError("Kullanıcı bulunamadı.");
        setLoading(false);
        return;
      }
      const user = result[0];
      if (user.password_hash !== loginForm.password) {
        setLoginError("Şifre hatalı.");
        setLoading(false);
        return;
      }
      setSession(user);
      await loadData(user);
      setPage("dashboard");
    } catch (e) {
      setLoginError("Bağlantı hatası: " + e.message);
    }
    setLoading(false);
  };

  const startThawing = async (batch) => {
    const now = new Date().toISOString();
    await supabase(`inventory_batches?id=eq.${batch.id}`, "PATCH", { status: "thawing", thaw_started_at: now });
    await logAction(batch, "frozen", "thawing", "Çözündürme başlatıldı");
    await loadData(session);
  };

  const moveToFoodFridge = async (batch) => {
    const now = new Date().toISOString();
    const exp = new Date(Date.now() + batch.cake_types.shelf_life_days * 86400000).toISOString();
    await supabase(`inventory_batches?id=eq.${batch.id}`, "PATCH", {
      status: "food_fridge", thaw_completed_at: now, food_fridge_at: now, expires_at: exp,
    });
    await logAction(batch, "thawing", "food_fridge", "Food dolabına alındı");
    await loadData(session);
  };

  const markSold = async (batch, qty = 1) => {
    const newQty = Math.max(0, batch.remaining_quantity - qty);
    const newStatus = newQty === 0 ? "sold_out" : "food_fridge";
    await supabase(`inventory_batches?id=eq.${batch.id}`, "PATCH", { remaining_quantity: newQty, status: newStatus });
    await supabase("sales", "POST", {
      store_id: batch.store_id, batch_id: batch.id,
      cake_type_id: batch.cake_type_id, quantity_sold: qty, sold_by: session?.id,
    });
    await logAction(batch, "food_fridge", newStatus, `${qty} adet satıldı`);
    await loadData(session);
  };

  const markDiscarded = async (batch) => {
    await supabase(`inventory_batches?id=eq.${batch.id}`, "PATCH", { status: "discarded", remaining_quantity: 0 });
    await logAction(batch, batch.status, "discarded", "İmha edildi");
    await loadData(session);
  };

  const logAction = async (batch, from, to, notes) => {
    try {
      await supabase("movement_log", "POST", {
        batch_id: batch.id, store_id: batch.store_id,
        action: to, from_status: from, to_status: to,
        quantity: batch.remaining_quantity, performed_by: session?.id, notes,
      }, "return=minimal");
    } catch (_) {}
  };

  const addBatch = async (form) => {
    await supabase("inventory_batches", "POST", {
      store_id: form.store_id, cake_type_id: form.cake_type_id,
      batch_label: form.batch_label, quantity: parseInt(form.quantity),
      remaining_quantity: parseInt(form.quantity), status: "frozen",
      frozen_at: new Date().toISOString(), notes: form.notes || null, created_by: session?.id,
    });
    await loadData(session);
    setModal(null);
  };

  const addUser = async (form) => {
    await supabase("app_users", "POST", {
      username: form.username, password_hash: form.password,
      full_name: form.full_name, role: form.role,
      store_id: form.store_id || null, is_active: true,
    });
    await loadData(session);
    setModal(null);
  };

  const addStore = async (form) => {
    await supabase("stores", "POST", { name: form.name, address: form.address, is_active: true });
    await loadData(session);
    setModal(null);
  };

  const addCakeType = async (form) => {
    await supabase("cake_types", "POST", {
      name: form.name, description: form.description,
      shelf_life_days: parseInt(form.shelf_life_days), is_active: true,
    });
    await loadData(session);
    setModal(null);
  };

  const filteredBatches = batches.filter(b =>
    (storeFilter === "all" || b.store_id === storeFilter) &&
    (statusFilter === "all" || b.status === statusFilter)
  );
  const priorSaleList = batches
    .filter(b => b.status === "food_fridge" && daysUntilExpiry(b.expires_at) !== null && daysUntilExpiry(b.expires_at) <= 2)
    .sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at));
  const thawingReady = batches.filter(b =>
    b.status === "thawing" && b.thaw_started_at &&
    (Date.now() - new Date(b.thaw_started_at)) / 3600000 >= 8
  );
  const stats = {
    frozen:      batches.filter(b => b.status === "frozen").length,
    thawing:     batches.filter(b => b.status === "thawing").length,
    food_fridge: batches.filter(b => b.status === "food_fridge").length,
    expiring:    priorSaleList.length,
  };

  if (!session) {
    return <LoginScreen form={loginForm} setForm={setLoginForm} onLogin={doLogin} error={loginError} loading={loading} />;
  }

  return (
    <div className="app">
      <style>{CSS}</style>
      <Sidebar page={page} setPage={setPage} session={session} onLogout={() => { setSession(null); setPage("dashboard"); }} />
      <main className="main-content">
        <TopBar
          title={PAGE_TITLES[page]}
          session={session}
          stores={stores}
          storeFilter={storeFilter}
          setStoreFilter={setStoreFilter}
          isSuperAdmin={session.role === "super_admin"}
        />
        {loading && <div className="loading-bar" />}
        {page === "dashboard" && (
          <Dashboard stats={stats} priorSaleList={priorSaleList} thawingReady={thawingReady}
            onMoveToFridge={moveToFoodFridge} onSell={markSold} />
        )}
        {page === "inventory" && (
          <Inventory batches={filteredBatches} statusFilter={statusFilter} setStatusFilter={setStatusFilter}
            onStartThaw={startThawing} onMoveToFridge={moveToFoodFridge} onSell={markSold}
            onDiscard={markDiscarded} onAdd={() => setModal("add_batch")} />
        )}
        {page === "sale_list" && <SaleList items={priorSaleList} onSell={markSold} onDiscard={markDiscarded} />}
        {page === "logs"      && <Logs logs={logs} />}
        {page === "admin" && session.role === "super_admin" && (
          <AdminPanel stores={stores} users={users} cakeTypes={cakeTypes}
            onAddStore={() => setModal("add_store")}
            onAddUser={() => setModal("add_user")}
            onAddCakeType={() => setModal("add_cake_type")} />
        )}
      </main>

      {modal === "add_batch"     && <AddBatchModal stores={stores} cakeTypes={cakeTypes} session={session} onSave={addBatch} onClose={() => setModal(null)} />}
      {modal === "add_store"     && <AddStoreModal onSave={addStore} onClose={() => setModal(null)} />}
      {modal === "add_user"      && <AddUserModal stores={stores} onSave={addUser} onClose={() => setModal(null)} />}
      {modal === "add_cake_type" && <AddCakeTypeModal onSave={addCakeType} onClose={() => setModal(null)} />}
    </div>
  );
}

const PAGE_TITLES = {
  dashboard: "Genel Bakış",
  inventory: "Envanter",
  sale_list: "Öneri Satış Listesi",
  logs:      "Hareket Geçmişi",
  admin:     "Yönetim Paneli",
};

// ─── LOGIN ─────────────────────────────────────────────────────────────────────
function LoginScreen({ form, setForm, onLogin, error, loading }) {
  return (
    <div className="login-screen">
      <style>{CSS}</style>
      <div className="login-card">
        <div className="login-logo">
          <span className="logo-icon">☕</span>
          <h1>Colombia Coffee</h1>
          <p>Pasta SKT Takip Sistemi</p>
        </div>
        <div className="field">
          <label>Kullanıcı Adı</label>
          <input value={form.username} onChange={e => setForm({ ...form, username: e.target.value })}
            placeholder="kullanıcı adı" onKeyDown={e => e.key === "Enter" && onLogin()} autoFocus />
        </div>
        <div className="field">
          <label>Şifre</label>
          <input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })}
            placeholder="••••••••" onKeyDown={e => e.key === "Enter" && onLogin()} />
        </div>
        {error && <div className="error-msg">{error}</div>}
        <button className="btn-primary login-btn" onClick={onLogin} disabled={loading}>
          {loading ? "Giriş yapılıyor..." : "Giriş Yap"}
        </button>
      </div>
    </div>
  );
}

// ─── SIDEBAR ──────────────────────────────────────────────────────────────────
function Sidebar({ page, setPage, session, onLogout }) {
  const nav = [
    { id: "dashboard", icon: "📊", label: "Dashboard" },
    { id: "inventory",  icon: "📦", label: "Envanter" },
    { id: "sale_list",  icon: "🏷️", label: "Satış Listesi" },
    { id: "logs",       icon: "📋", label: "Geçmiş" },
    ...(session.role === "super_admin" ? [{ id: "admin", icon: "⚙️", label: "Yönetim" }] : []),
  ];
  return (
    <aside className="sidebar">
      <div className="sidebar-logo"><span>☕</span><span className="sidebar-brand">Colombia</span></div>
      <nav className="sidebar-nav">
        {nav.map(item => (
          <button key={item.id} className={`nav-item ${page === item.id ? "active" : ""}`} onClick={() => setPage(item.id)}>
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-user">
        <div className="user-info">
          <div className="user-avatar">{session.full_name?.[0] || "U"}</div>
          <div>
            <div className="user-name">{session.full_name}</div>
            <div className="user-role">
              {session.role === "super_admin" ? "Süper Admin" : session.role === "store_manager" ? "Mağaza Müdürü" : "Personel"}
            </div>
          </div>
        </div>
        <button className="logout-btn" onClick={onLogout} title="Çıkış Yap">⏏</button>
      </div>
    </aside>
  );
}

// ─── TOP BAR ──────────────────────────────────────────────────────────────────
function TopBar({ title, session, stores, storeFilter, setStoreFilter, isSuperAdmin }) {
  return (
    <div className="topbar">
      <h2 className="topbar-title">{title}</h2>
      <div className="topbar-right">
        {isSuperAdmin && (
          <select className="store-filter" value={storeFilter} onChange={e => setStoreFilter(e.target.value)}>
            <option value="all">Tüm Mağazalar</option>
            {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        {!isSuperAdmin && session.stores && (
          <span className="store-badge">🏪 {session.stores?.name}</span>
        )}
        <span className="date-badge">
          {new Date().toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long" })}
        </span>
      </div>
    </div>
  );
}

// ─── STAT CARD ────────────────────────────────────────────────────────────────
function StatCard({ icon, label, value, color }) {
  return (
    <div className={`stat-card stat-${color}`}>
      <div className="stat-icon">{icon}</div>
      <div className="stat-body">
        <div className="stat-value">{value}</div>
        <div className="stat-label">{label}</div>
      </div>
    </div>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function Dashboard({ stats, priorSaleList, thawingReady, onMoveToFridge, onSell }) {
  return (
    <div className="dashboard">
      <div className="stats-grid">
        <StatCard icon="❄️" label="Donuk Depo"   value={stats.frozen}      color="blue" />
        <StatCard icon="🌡️" label="Çözünmede"    value={stats.thawing}     color="orange" />
        <StatCard icon="🧁" label="Food Dolabı"  value={stats.food_fridge} color="green" />
        <StatCard icon="⚠️" label="SKT Yaklaşan" value={stats.expiring}    color="red" />
      </div>

      {thawingReady.length > 0 && (
        <div className="section">
          <h3 className="section-title">🕐 Food Dolabına Aktarılmayı Bekleyenler</h3>
          <div className="card-list">
            {thawingReady.map(b => (
              <div key={b.id} className="batch-card thawing-ready">
                <div className="batch-info">
                  <strong>{b.batch_label}</strong>
                  <span>{b.cake_types?.name}</span>
                  <span className="qty-badge">{b.remaining_quantity} adet</span>
                </div>
                <div className="batch-meta"><small>Çözünme: {formatDate(b.thaw_started_at)}</small></div>
                <button className="btn-action btn-green" onClick={() => onMoveToFridge(b)}>➡️ Food Dolabına Al</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {priorSaleList.length > 0 && (
        <div className="section">
          <h3 className="section-title">🏷️ Öncelikli Satış Listesi</h3>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Ürün</th><th>Parti</th><th>SKT</th><th>Kalan</th><th>Mağaza</th><th>İşlem</th></tr>
              </thead>
              <tbody>
                {priorSaleList.map(b => {
                  const days = daysUntilExpiry(b.expires_at);
                  const urg = getUrgencyClass(days);
                  return (
                    <tr key={b.id} className={`urgency-${urg}`}>
                      <td><strong>{b.cake_types?.name}</strong></td>
                      <td>{b.batch_label}</td>
                      <td>
                        <span className={`skt-badge skt-${urg}`}>
                          {days < 0 ? "⛔ Geçti" : days <= 1 ? "🔴 Son gün" : `⚠️ ${Math.ceil(days)} gün`}
                        </span>
                        <br /><small>{formatDateOnly(b.expires_at)}</small>
                      </td>
                      <td>{b.remaining_quantity}</td>
                      <td><small>{b.stores?.name}</small></td>
                      <td><button className="btn-sm btn-sell" onClick={() => onSell(b, 1)}>Sat (1)</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {priorSaleList.length === 0 && thawingReady.length === 0 && (
        <div className="empty-state">
          <span>✅</span>
          <p>Her şey yolunda! SKT yaklaşan veya işlem bekleyen ürün yok.</p>
        </div>
      )}
    </div>
  );
}

// ─── INVENTORY ────────────────────────────────────────────────────────────────
function Inventory({ batches, statusFilter, setStatusFilter, onStartThaw, onMoveToFridge, onSell, onDiscard, onAdd }) {
  const [selling, setSelling] = useState(null);
  const [sellQty, setSellQty] = useState(1);

  return (
    <div className="inventory">
      <div className="toolbar">
        <div className="filter-tabs">
          {[
            ["all", "Tümü"], ["frozen", "❄️ Donuk"], ["thawing", "🌡️ Çözünme"],
            ["food_fridge", "🧁 Food Dolabı"], ["sold_out", "✅ Satıldı"], ["discarded", "🗑️ İmha"],
          ].map(([v, l]) => (
            <button key={v} className={`filter-tab ${statusFilter === v ? "active" : ""}`}
              onClick={() => setStatusFilter(v)}>{l}</button>
          ))}
        </div>
        <button className="btn-primary" onClick={onAdd}>+ Yeni Parti Ekle</button>
      </div>

      {selling && (
        <div className="inline-sell">
          <strong>Kaç adet satıldı?</strong>
          <input type="number" min="1" max={selling.remaining_quantity} value={sellQty}
            onChange={e => setSellQty(parseInt(e.target.value))} />
          <button className="btn-sm btn-sell" onClick={() => { onSell(selling, sellQty); setSelling(null); setSellQty(1); }}>Onayla</button>
          <button className="btn-sm" onClick={() => { setSelling(null); setSellQty(1); }}>İptal</button>
        </div>
      )}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Parti Adı</th><th>Ürün</th><th>Mağaza</th><th>Durum</th>
              <th>Donuğa Giriş</th><th>Food Dolabına</th><th>SKT</th><th>Kalan/Top.</th><th>İşlemler</th>
            </tr>
          </thead>
          <tbody>
            {batches.length === 0 && (
              <tr><td colSpan="9" className="empty-cell">Kayıt bulunamadı</td></tr>
            )}
            {batches.map(b => {
              const days = daysUntilExpiry(b.expires_at);
              const urg = b.status === "food_fridge" ? getUrgencyClass(days) : "";
              return (
                <tr key={b.id} className={`urgency-${urg}`}>
                  <td><strong>{b.batch_label}</strong></td>
                  <td>{b.cake_types?.name}</td>
                  <td><small>{b.stores?.name}</small></td>
                  <td>
                    <span className="status-pill"
                      style={{ background: STATUS_LABELS[b.status]?.color + "33", color: STATUS_LABELS[b.status]?.color }}>
                      {STATUS_LABELS[b.status]?.label}
                    </span>
                  </td>
                  <td><small>{formatDate(b.frozen_at)}</small></td>
                  <td><small>{b.food_fridge_at ? formatDate(b.food_fridge_at) : "—"}</small></td>
                  <td>
                    {b.expires_at
                      ? <span className={`skt-badge skt-${urg}`}>{days < 0 ? "⛔ Geçti" : `${Math.ceil(days)} gün`}<br /><small>{formatDateOnly(b.expires_at)}</small></span>
                      : "—"}
                  </td>
                  <td>{b.remaining_quantity} / {b.quantity}</td>
                  <td>
                    <div className="action-btns">
                      {b.status === "frozen" && (
                        <button className="btn-sm btn-orange" onClick={() => onStartThaw(b)}>🌡️ Çözüt</button>
                      )}
                      {b.status === "thawing" && (
                        <button className="btn-sm btn-green" onClick={() => onMoveToFridge(b)}>🧁 Dolaba Al</button>
                      )}
                      {b.status === "food_fridge" && (
                        <>
                          <button className="btn-sm btn-sell" onClick={() => { setSelling(b); setSellQty(1); }}>💰 Sat</button>
                          <button className="btn-sm btn-red" onClick={() => onDiscard(b)}>🗑️</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── SALE LIST ────────────────────────────────────────────────────────────────
function SaleList({ items, onSell, onDiscard }) {
  const [sellQty, setSellQty] = useState({});

  if (items.length === 0) {
    return (
      <div className="empty-state big">
        <span>🎉</span>
        <p>Öncelikli satış listesi boş! Tüm ürünler taze.</p>
      </div>
    );
  }

  return (
    <div className="sale-list-page">
      <div className="alert-banner">
        ⚠️ Aşağıdaki {items.length} ürün SKT'ye 2 gün veya daha az kalmış. Öncelikli satışa sunun.
      </div>
      <div className="sale-cards">
        {items.map(b => {
          const days = daysUntilExpiry(b.expires_at);
          const urg = getUrgencyClass(days);
          return (
            <div key={b.id} className={`sale-card urgency-card-${urg}`}>
              <div className="sale-card-header">
                <span className={`skt-badge skt-${urg} big`}>
                  {days < 0 ? "⛔ SKT GEÇTİ" : days <= 1 ? "🔴 SON GÜN" : `⚠️ ${Math.ceil(days)} GÜN KALDI`}
                </span>
                <span className="sale-store">{b.stores?.name}</span>
              </div>
              <div className="sale-card-body">
                <h3>{b.cake_types?.name}</h3>
                <p className="sale-batch">{b.batch_label}</p>
                <div className="sale-meta">
                  <span>SKT: <strong>{formatDateOnly(b.expires_at)}</strong></span>
                  <span>Kalan: <strong>{b.remaining_quantity} adet</strong></span>
                </div>
              </div>
              <div className="sale-card-footer">
                <div className="qty-input-row">
                  <label>Satış adedi:</label>
                  <input type="number" min="1" max={b.remaining_quantity}
                    value={sellQty[b.id] || 1}
                    onChange={e => setSellQty(p => ({ ...p, [b.id]: e.target.value }))} />
                </div>
                <div className="sale-actions">
                  <button className="btn-sell-big" onClick={() => {
                    onSell(b, parseInt(sellQty[b.id] || 1));
                    setSellQty(p => ({ ...p, [b.id]: 1 }));
                  }}>✅ Satıldı</button>
                  <button className="btn-discard-sm" onClick={() => onDiscard(b)}>🗑️ İmha</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── LOGS ─────────────────────────────────────────────────────────────────────
function Logs({ logs }) {
  const ACT = {
    frozen: "❄️ Donuğa eklendi", thawing: "🌡️ Çözündürme başlatıldı",
    food_fridge: "🧁 Food dolabına alındı", sold_out: "✅ Satıldı",
    discarded: "🗑️ İmha edildi", updated: "📝 Güncellendi",
  };
  return (
    <div className="logs-page">
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr><th>Tarih</th><th>İşlem</th><th>Parti</th><th>Mağaza</th><th>Yapan</th><th>Not</th></tr>
          </thead>
          <tbody>
            {logs.length === 0 && <tr><td colSpan="6" className="empty-cell">Henüz kayıt yok</td></tr>}
            {logs.map(l => (
              <tr key={l.id}>
                <td><small>{formatDate(l.performed_at)}</small></td>
                <td>{ACT[l.action] || l.action}</td>
                <td>{l.inventory_batches?.batch_label || "—"}</td>
                <td><small>{l.stores?.name}</small></td>
                <td><small>{l.app_users?.full_name || "—"}</small></td>
                <td><small>{l.notes || "—"}</small></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── ADMIN ────────────────────────────────────────────────────────────────────
function AdminPanel({ stores, users, cakeTypes, onAddStore, onAddUser, onAddCakeType }) {
  const [tab, setTab] = useState("stores");
  return (
    <div className="admin-panel">
      <div className="admin-tabs">
        {[["stores", "🏪 Mağazalar"], ["users", "👤 Kullanıcılar"], ["cake_types", "🎂 Pasta Çeşitleri"]].map(([v, l]) => (
          <button key={v} className={`admin-tab ${tab === v ? "active" : ""}`} onClick={() => setTab(v)}>{l}</button>
        ))}
      </div>
      {tab === "stores" && (
        <div>
          <div className="admin-header"><h3>Mağazalar ({stores.length})</h3><button className="btn-primary" onClick={onAddStore}>+ Mağaza Ekle</button></div>
          <div className="table-wrap"><table className="data-table"><thead><tr><th>Mağaza Adı</th><th>Adres</th><th>Durum</th></tr></thead><tbody>
            {stores.map(s => <tr key={s.id}><td><strong>{s.name}</strong></td><td><small>{s.address || "—"}</small></td><td><span className={`pill ${s.is_active ? "active" : "inactive"}`}>{s.is_active ? "Aktif" : "Pasif"}</span></td></tr>)}
          </tbody></table></div>
        </div>
      )}
      {tab === "users" && (
        <div>
          <div className="admin-header"><h3>Kullanıcılar ({users.length})</h3><button className="btn-primary" onClick={onAddUser}>+ Kullanıcı Ekle</button></div>
          <div className="table-wrap"><table className="data-table"><thead><tr><th>Ad Soyad</th><th>Kullanıcı Adı</th><th>Rol</th><th>Mağaza</th><th>Durum</th></tr></thead><tbody>
            {users.map(u => <tr key={u.id}><td><strong>{u.full_name}</strong></td><td><code>{u.username}</code></td><td><span className="role-pill">{u.role}</span></td><td><small>{u.stores?.name || "—"}</small></td><td><span className={`pill ${u.is_active ? "active" : "inactive"}`}>{u.is_active ? "Aktif" : "Pasif"}</span></td></tr>)}
          </tbody></table></div>
        </div>
      )}
      {tab === "cake_types" && (
        <div>
          <div className="admin-header"><h3>Pasta Çeşitleri ({cakeTypes.length})</h3><button className="btn-primary" onClick={onAddCakeType}>+ Çeşit Ekle</button></div>
          <div className="table-wrap"><table className="data-table"><thead><tr><th>Pasta Adı</th><th>Açıklama</th><th>SKT Süresi</th><th>Durum</th></tr></thead><tbody>
            {cakeTypes.map(ct => <tr key={ct.id}><td><strong>{ct.name}</strong></td><td><small>{ct.description || "—"}</small></td><td><span className="skt-days">{ct.shelf_life_days} gün</span></td><td><span className={`pill ${ct.is_active ? "active" : "inactive"}`}>{ct.is_active ? "Aktif" : "Pasif"}</span></td></tr>)}
          </tbody></table></div>
        </div>
      )}
    </div>
  );
}

// ─── MODALS ───────────────────────────────────────────────────────────────────
function Modal({ title, children, onClose }) {
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header"><h3>{title}</h3><button className="modal-close" onClick={onClose}>✕</button></div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
function F({ label, children }) {
  return <div className="field"><label>{label}</label>{children}</div>;
}
function AddBatchModal({ stores, cakeTypes, session, onSave, onClose }) {
  const [form, setForm] = useState({ store_id: session.store_id || stores[0]?.id || "", cake_type_id: cakeTypes[0]?.id || "", batch_label: "", quantity: 1, notes: "" });
  const s = k => e => setForm(p => ({ ...p, [k]: e.target.value }));
  return (
    <Modal title="Yeni Parti Ekle" onClose={onClose}>
      {session.role === "super_admin" && <F label="Mağaza"><select value={form.store_id} onChange={s("store_id")}>{stores.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></F>}
      <F label="Pasta Çeşidi"><select value={form.cake_type_id} onChange={s("cake_type_id")}>{cakeTypes.map(ct => <option key={ct.id} value={ct.id}>{ct.name} ({ct.shelf_life_days} gün SKT)</option>)}</select></F>
      <F label="Parti Etiketi"><input value={form.batch_label} onChange={s("batch_label")} placeholder="ör. Cheesecake #012" /></F>
      <F label="Adet"><input type="number" min="1" value={form.quantity} onChange={s("quantity")} /></F>
      <F label="Not (opsiyonel)"><input value={form.notes} onChange={s("notes")} placeholder="Varsa not..." /></F>
      <div className="modal-footer"><button className="btn-primary" onClick={() => onSave(form)}>Kaydet</button><button className="btn-ghost" onClick={onClose}>İptal</button></div>
    </Modal>
  );
}
function AddStoreModal({ onSave, onClose }) {
  const [form, setForm] = useState({ name: "", address: "" });
  const s = k => e => setForm(p => ({ ...p, [k]: e.target.value }));
  return (
    <Modal title="Yeni Mağaza" onClose={onClose}>
      <F label="Mağaza Adı"><input value={form.name} onChange={s("name")} /></F>
      <F label="Adres"><input value={form.address} onChange={s("address")} /></F>
      <div className="modal-footer"><button className="btn-primary" onClick={() => onSave(form)}>Kaydet</button><button className="btn-ghost" onClick={onClose}>İptal</button></div>
    </Modal>
  );
}
function AddUserModal({ stores, onSave, onClose }) {
  const [form, setForm] = useState({ username: "", password: "", full_name: "", role: "staff", store_id: "" });
  const s = k => e => setForm(p => ({ ...p, [k]: e.target.value }));
  return (
    <Modal title="Yeni Kullanıcı" onClose={onClose}>
      <F label="Ad Soyad"><input value={form.full_name} onChange={s("full_name")} /></F>
      <F label="Kullanıcı Adı"><input value={form.username} onChange={s("username")} /></F>
      <F label="Şifre"><input type="password" value={form.password} onChange={s("password")} /></F>
      <F label="Rol"><select value={form.role} onChange={s("role")}><option value="staff">Personel</option><option value="store_manager">Mağaza Müdürü</option><option value="super_admin">Süper Admin</option></select></F>
      <F label="Mağaza"><select value={form.store_id} onChange={s("store_id")}><option value="">— Merkez (tüm mağazalar) —</option>{stores.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></F>
      <div className="modal-footer"><button className="btn-primary" onClick={() => onSave(form)}>Kaydet</button><button className="btn-ghost" onClick={onClose}>İptal</button></div>
    </Modal>
  );
}
function AddCakeTypeModal({ onSave, onClose }) {
  const [form, setForm] = useState({ name: "", description: "", shelf_life_days: "3" });
  const s = k => e => setForm(p => ({ ...p, [k]: e.target.value }));
  return (
    <Modal title="Yeni Pasta Çeşidi" onClose={onClose}>
      <F label="Pasta Adı"><input value={form.name} onChange={s("name")} /></F>
      <F label="Açıklama"><input value={form.description} onChange={s("description")} /></F>
      <F label="SKT Süresi"><select value={form.shelf_life_days} onChange={s("shelf_life_days")}><option value="3">3 Gün</option><option value="4">4 Gün</option></select></F>
      <div className="modal-footer"><button className="btn-primary" onClick={() => onSave(form)}>Kaydet</button><button className="btn-ghost" onClick={onClose}>İptal</button></div>
    </Modal>
  );
}

// ─── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0f1117; --surface: #1a1d26; --surface2: #22263a; --border: #2a2f45;
    --accent: #c8974f; --accent2: #e8b872; --text: #e8eaf0; --text2: #8b90a8;
    --blue: #4fc3f7; --green: #81c784; --orange: #ffb74d; --red: #ef5350;
    --r: 10px; --font: 'Plus Jakarta Sans', sans-serif; --mono: 'JetBrains Mono', monospace;
  }
  body { font-family: var(--font); background: var(--bg); color: var(--text); min-height: 100vh; }
  .app { display: flex; min-height: 100vh; }
  .sidebar { width: 220px; min-height: 100vh; background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; position: fixed; top: 0; left: 0; bottom: 0; z-index: 100; }
  .sidebar-logo { padding: 20px 16px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--border); font-size: 24px; }
  .sidebar-brand { font-size: 16px; font-weight: 700; color: var(--accent); }
  .sidebar-nav { flex: 1; padding: 12px 8px; display: flex; flex-direction: column; gap: 4px; }
  .nav-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; border: none; background: transparent; color: var(--text2); font-family: var(--font); font-size: 14px; font-weight: 500; cursor: pointer; transition: all .15s; text-align: left; width: 100%; }
  .nav-item:hover { background: var(--surface2); color: var(--text); }
  .nav-item.active { background: var(--accent)22; color: var(--accent); }
  .nav-icon { font-size: 16px; width: 20px; text-align: center; }
  .sidebar-user { padding: 16px; border-top: 1px solid var(--border); display: flex; align-items: center; gap: 8px; }
  .user-info { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
  .user-avatar { width: 32px; height: 32px; border-radius: 50%; background: var(--accent); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14px; color: #000; flex-shrink: 0; }
  .user-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .user-role { font-size: 11px; color: var(--text2); }
  .logout-btn { background: none; border: 1px solid var(--border); color: var(--text2); cursor: pointer; padding: 6px 8px; border-radius: 6px; font-size: 14px; flex-shrink: 0; }
  .logout-btn:hover { color: var(--red); border-color: var(--red); }
  .main-content { margin-left: 220px; flex: 1; min-height: 100vh; display: flex; flex-direction: column; }
  .topbar { padding: 16px 24px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; background: var(--surface); position: sticky; top: 0; z-index: 50; flex-wrap: wrap; gap: 8px; }
  .topbar-title { font-size: 18px; font-weight: 700; }
  .topbar-right { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .store-filter { background: var(--surface2); border: 1px solid var(--border); color: var(--text); padding: 6px 10px; border-radius: 8px; font-family: var(--font); font-size: 13px; }
  .store-badge { background: var(--surface2); border: 1px solid var(--border); padding: 6px 12px; border-radius: 8px; font-size: 13px; }
  .date-badge { color: var(--text2); font-size: 13px; }
  .loading-bar { height: 3px; background: linear-gradient(90deg, var(--accent), var(--accent2)); animation: ld 1s ease infinite; }
  @keyframes ld { 0%, 100% { opacity: .5 } 50% { opacity: 1 } }
  .dashboard, .inventory, .sale-list-page, .logs-page, .admin-panel { padding: 24px; flex: 1; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 28px; }
  .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); padding: 20px; display: flex; align-items: center; gap: 16px; }
  .stat-card.stat-blue  { border-left: 3px solid var(--blue); }
  .stat-card.stat-orange{ border-left: 3px solid var(--orange); }
  .stat-card.stat-green { border-left: 3px solid var(--green); }
  .stat-card.stat-red   { border-left: 3px solid var(--red); }
  .stat-icon { font-size: 28px; } .stat-value { font-size: 28px; font-weight: 700; font-family: var(--mono); } .stat-label { font-size: 12px; color: var(--text2); margin-top: 2px; }
  .section { margin-bottom: 28px; } .section-title { font-size: 15px; font-weight: 700; color: var(--text2); margin-bottom: 12px; text-transform: uppercase; letter-spacing: .5px; }
  .card-list { display: flex; flex-direction: column; gap: 10px; }
  .batch-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); padding: 14px 16px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .batch-card.thawing-ready { border-color: var(--green); }
  .batch-info { display: flex; align-items: center; gap: 12px; flex: 1; flex-wrap: wrap; }
  .batch-info strong { font-size: 15px; } .batch-info span { color: var(--text2); font-size: 13px; }
  .qty-badge { background: var(--surface2); padding: 2px 8px; border-radius: 20px; font-size: 12px; font-weight: 600; }
  .table-wrap { overflow-x: auto; border-radius: var(--r); border: 1px solid var(--border); }
  .data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .data-table th { background: var(--surface2); padding: 10px 14px; text-align: left; font-size: 11px; font-weight: 700; color: var(--text2); text-transform: uppercase; letter-spacing: .5px; white-space: nowrap; }
  .data-table td { padding: 10px 14px; border-top: 1px solid var(--border); vertical-align: middle; }
  .data-table tr:hover td { background: var(--surface2)66; }
  .empty-cell { text-align: center; color: var(--text2); padding: 32px !important; }
  tr.urgency-critical td { background: #ef535011 !important; } tr.urgency-warning td { background: #ffb74d11 !important; } tr.urgency-expired td { background: #ef535022 !important; }
  .status-pill { padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; border: 1px solid currentColor; }
  .skt-badge { font-size: 12px; font-weight: 700; padding: 3px 8px; border-radius: 6px; display: inline-block; }
  .skt-badge.big { font-size: 14px; padding: 6px 12px; }
  .skt-ok { background: #81c78422; color: var(--green); } .skt-warning { background: #ffb74d22; color: var(--orange); } .skt-critical { background: #ef535022; color: var(--red); } .skt-expired { background: #ef535044; color: #ff8a80; }
  .skt-days { background: var(--surface2); padding: 3px 10px; border-radius: 20px; font-size: 13px; font-weight: 700; font-family: var(--mono); }
  .pill.active   { background: #81c78422; color: var(--green);  padding: 3px 10px; border-radius: 20px; font-size: 12px; }
  .pill.inactive { background: #ef535022; color: var(--red);    padding: 3px 10px; border-radius: 20px; font-size: 12px; }
  .role-pill { background: var(--accent)22; color: var(--accent); padding: 3px 10px; border-radius: 20px; font-size: 12px; }
  code { font-family: var(--mono); background: var(--surface2); padding: 2px 6px; border-radius: 4px; font-size: 12px; }
  .btn-primary { background: var(--accent); color: #000; border: none; padding: 9px 18px; border-radius: 8px; font-family: var(--font); font-weight: 700; font-size: 13px; cursor: pointer; white-space: nowrap; }
  .btn-primary:hover { background: var(--accent2); } .btn-primary:disabled { opacity: .5; cursor: not-allowed; }
  .btn-ghost { background: transparent; color: var(--text2); border: 1px solid var(--border); padding: 9px 18px; border-radius: 8px; font-family: var(--font); font-size: 13px; cursor: pointer; }
  .btn-sm { padding: 5px 10px; border-radius: 6px; font-size: 12px; font-family: var(--font); font-weight: 600; cursor: pointer; border: none; }
  .btn-orange { background: var(--orange)22; color: var(--orange); } .btn-green { background: var(--green)22; color: var(--green); } .btn-sell { background: #4fc3f722; color: var(--blue); } .btn-red { background: var(--red)22; color: var(--red); }
  .btn-action { padding: 7px 14px; border-radius: 8px; font-weight: 600; font-size: 13px; cursor: pointer; border: none; font-family: var(--font); }
  .action-btns { display: flex; gap: 6px; }
  .toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; gap: 12px; flex-wrap: wrap; }
  .filter-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
  .filter-tab { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--text2); font-family: var(--font); font-size: 12px; cursor: pointer; }
  .filter-tab.active { background: var(--surface2); color: var(--text); border-color: var(--accent); }
  .inline-sell { background: var(--surface2); border: 1px solid var(--accent); border-radius: 8px; padding: 10px 14px; display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
  .inline-sell input { width: 70px; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 5px 8px; border-radius: 6px; font-size: 14px; text-align: center; }
  .alert-banner { background: #ffb74d22; border: 1px solid var(--orange); border-radius: 8px; padding: 12px 16px; color: var(--orange); font-size: 14px; font-weight: 600; margin-bottom: 20px; }
  .sale-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
  .sale-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .urgency-card-critical { border-color: var(--red); } .urgency-card-warning { border-color: var(--orange); } .urgency-card-expired { border-color: #ff8a80; }
  .sale-card-header { padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; background: var(--surface2); }
  .sale-store { font-size: 12px; color: var(--text2); }
  .sale-card-body { padding: 16px; } .sale-card-body h3 { font-size: 18px; font-weight: 700; margin-bottom: 4px; }
  .sale-batch { font-size: 13px; color: var(--text2); margin-bottom: 12px; } .sale-meta { display: flex; gap: 20px; font-size: 13px; }
  .sale-card-footer { padding: 14px 16px; border-top: 1px solid var(--border); }
  .qty-input-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; font-size: 13px; }
  .qty-input-row input { width: 60px; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 5px 8px; border-radius: 6px; text-align: center; font-size: 14px; }
  .sale-actions { display: flex; gap: 8px; }
  .btn-sell-big { flex: 1; background: var(--green)22; color: var(--green); border: 1px solid var(--green)44; padding: 10px; border-radius: 8px; font-weight: 700; font-size: 14px; cursor: pointer; font-family: var(--font); }
  .btn-sell-big:hover { background: var(--green)44; }
  .btn-discard-sm { background: var(--red)22; color: var(--red); border: 1px solid var(--red)44; padding: 10px 14px; border-radius: 8px; font-size: 14px; cursor: pointer; }
  .admin-tabs { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
  .admin-tab { padding: 9px 20px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--text2); font-family: var(--font); font-size: 14px; font-weight: 600; cursor: pointer; }
  .admin-tab.active { background: var(--surface2); color: var(--accent); border-color: var(--accent); }
  .admin-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .admin-header h3 { font-size: 16px; font-weight: 700; }
  .field { margin-bottom: 14px; } .field label { display: block; font-size: 12px; font-weight: 700; color: var(--text2); margin-bottom: 6px; text-transform: uppercase; letter-spacing: .5px; }
  .field input, .field select { width: 100%; background: var(--surface2); border: 1px solid var(--border); color: var(--text); padding: 9px 12px; border-radius: 8px; font-family: var(--font); font-size: 14px; }
  .field input:focus, .field select:focus { outline: none; border-color: var(--accent); }
  .modal-footer { display: flex; gap: 10px; margin-top: 20px; }
  .modal-overlay { position: fixed; inset: 0; background: #00000088; z-index: 200; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .modal { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; width: 100%; max-width: 460px; max-height: 90vh; overflow-y: auto; }
  .modal-header { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
  .modal-header h3 { font-size: 16px; font-weight: 700; } .modal-close { background: none; border: none; color: var(--text2); font-size: 18px; cursor: pointer; }
  .modal-body { padding: 20px; }
  .login-screen { min-height: 100vh; background: var(--bg); display: flex; align-items: center; justify-content: center; padding: 20px; }
  .login-card { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; width: 100%; max-width: 400px; padding: 36px; }
  .login-logo { text-align: center; margin-bottom: 28px; } .logo-icon { font-size: 40px; }
  .login-logo h1 { font-size: 22px; font-weight: 800; color: var(--accent); margin-top: 8px; } .login-logo p { font-size: 13px; color: var(--text2); margin-top: 4px; }
  .login-btn { width: 100%; margin-top: 8px; padding: 12px; font-size: 15px; }
  .error-msg { background: #ef535022; color: var(--red); border: 1px solid var(--red)44; padding: 10px; border-radius: 8px; font-size: 13px; margin-bottom: 10px; }
  .empty-state { text-align: center; padding: 60px 20px; color: var(--text2); }
  .empty-state span { font-size: 48px; display: block; margin-bottom: 12px; } .empty-state.big { padding: 100px 20px; } .empty-state p { font-size: 16px; }
  @media (max-width: 768px) {
    .sidebar { width: 60px; }
    .sidebar-brand, .nav-label, .user-name, .user-role { display: none; }
    .main-content { margin-left: 60px; }
    .stats-grid { grid-template-columns: repeat(2, 1fr); }
    .sale-cards { grid-template-columns: 1fr; }
  }
`;
